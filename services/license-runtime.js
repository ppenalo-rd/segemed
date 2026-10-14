const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { verifyLocalLicense } = require('./license-verifier');

const DEFAULT_REFRESH_INTERVAL_MS = 60 * 1000;
const execFileAsync = promisify(execFile);

function readOnlyStatus(reason, installationId, message = null) {
  return {
    status: 'read_only',
    reason,
    installationId,
    license: null,
    checkedAt: null,
    message,
  };
}

function getLicenseWriteStatus(status, now) {
  if (status.reason === 'development_mode') return status;
  if (status.status !== 'active') return status;
  const lastSeenTime = Date.parse(status.lastSeenAt);
  const currentTime = now.getTime();
  if (!Number.isFinite(lastSeenTime) || currentTime < lastSeenTime) {
    return { ...status, status: 'read_only', reason: 'clock_rollback' };
  }
  if (currentTime >= Date.parse(status.license.expiresAt)) {
    return { ...status, status: 'read_only', reason: 'expired' };
  }
  return status;
}

/**
 * Keeps the verified license decision in memory, refreshes it periodically, and fails closed.
 */
function createLicenseRuntime({
  licenseStore,
  stateStore,
  publicKey,
  installationId,
  now = () => new Date(),
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  enforcementEnabled = true,
}) {
  if (typeof now !== 'function') throw new TypeError('now debe ser una función.');
  if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs < 1000) {
    throw new RangeError('refreshIntervalMs debe ser un entero de al menos 1000 ms.');
  }

  let status = enforcementEnabled
    ? readOnlyStatus('license_not_initialized', installationId)
    : {
      status: 'active',
      reason: 'development_mode',
      installationId: installationId || null,
      license: null,
      checkedAt: null,
      lastSeenAt: null,
      message: null,
    };
  let refreshPromise = null;
  let refreshTimer = null;

  const currentStatus = () => getLicenseWriteStatus(status, now());

  async function refresh() {
    if (!enforcementEnabled) return status;
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      if (!installationId) {
        status = readOnlyStatus('installation_id_unavailable', installationId);
        return status;
      }
      if (!publicKey) {
        status = readOnlyStatus('license_public_key_unavailable', installationId);
        return status;
      }
      if (!licenseStore || typeof licenseStore.loadLicense !== 'function') {
        status = readOnlyStatus('license_store_unavailable', installationId);
        return status;
      }

      try {
        const license = await licenseStore.loadLicense();
        if (!license) {
          status = readOnlyStatus('missing_license', installationId);
          return status;
        }
        const decision = await verifyLocalLicense({
          license,
          publicKey,
          installationId,
          stateStore,
          now: now(),
        });
        status = {
          ...decision,
          installationId,
          checkedAt: now().toISOString(),
          lastSeenAt: decision.status === 'active'
            ? now().toISOString()
            : (await stateStore.load())?.lastSeenAt || null,
          message: null,
        };
        return currentStatus();
      } catch (error) {
        status = readOnlyStatus(
          'license_storage_error',
          installationId,
          'No se pudo leer o validar el estado local de la licencia.'
        );
        throw error;
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  async function installLicense(licenseContent) {
    if (!enforcementEnabled) {
      throw new Error('La validación de licencias no está habilitada en este entorno.');
    }
    if (!licenseStore || typeof licenseStore.saveLicense !== 'function') {
      throw new Error('El almacén local no permite instalar licencias.');
    }
    if (!publicKey || !installationId) {
      throw new Error('La instalación no tiene configurada la clave pública o el identificador del equipo.');
    }
    const decision = await verifyLocalLicense({
      license: licenseContent,
      publicKey,
      installationId,
      stateStore,
      now: now(),
    });
    if (decision.status !== 'active') {
      const error = new Error(`La licencia no se puede instalar: ${decision.reason}.`);
      error.code = decision.reason;
      throw error;
    }
    await licenseStore.saveLicense(
      typeof licenseContent === 'string' ? licenseContent : JSON.stringify(licenseContent)
    );
    await refresh();
    return currentStatus();
  }

  function start() {
    if (refreshTimer) return refreshTimer;
    refreshTimer = setInterval(() => {
      refresh().catch((error) => {
        console.error('No se pudo actualizar el estado de licencia:', error.message);
      });
    }, refreshIntervalMs);
    refreshTimer.unref?.();
    return refreshTimer;
  }

  function stop() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  return Object.freeze({
    getStatus: currentStatus,
    refresh,
    installLicense,
    start,
    stop,
  });
}

/**
 * Derives a non-reversible installation identifier from Windows MachineGuid.
 */
function deriveInstallationId(machineGuid) {
  if (typeof machineGuid !== 'string' || !machineGuid.trim()) {
    throw new TypeError('MachineGuid no está disponible.');
  }
  const digest = createHash('sha256')
    .update(`SIGEMED|installation|${machineGuid.trim().toLowerCase()}`)
    .digest('hex');
  return `sigemed-${digest}`;
}

/**
 * Reads the Windows machine identifier without returning or persisting it in plaintext.
 */
async function readWindowsInstallationId(powershellPath = 'powershell.exe') {
  if (process.platform !== 'win32') {
    throw new Error('La identificación automática de instalación solo está disponible en Windows.');
  }
  const command = [
    '$ErrorActionPreference = "Stop"',
    '(Get-ItemPropertyValue -Path "HKLM:\\SOFTWARE\\Microsoft\\Cryptography" -Name "MachineGuid").ToString()',
  ].join('; ');
  const { stdout } = await execFileAsync(powershellPath, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command,
  ], {
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 4096,
  });
  return deriveInstallationId(stdout.trim());
}

function createClinicalLicenseGuard(getRuntime) {
  return (req, res, next) => {
    const runtime = getRuntime();
    const licenseStatus = runtime?.getStatus()
      || readOnlyStatus('license_not_initialized', null);
    if (licenseStatus.status === 'active') return next();

    res.set('Cache-Control', 'no-store');
    if (req.is('application/json') || req.get('x-csrf-token')) {
      return res.status(423).json({
        error: 'license_read_only',
        reason: licenseStatus.reason,
        expiresAt: licenseStatus.license?.expiresAt || null,
      });
    }
    return res.status(423).render('license_locked', {
      licenseStatus,
      isSystemAdmin: req.session.user?.roles?.includes('system_admin') === true,
    });
  };
}

module.exports = {
  createClinicalLicenseGuard,
  createLicenseRuntime,
  deriveInstallationId,
  getLicenseWriteStatus,
  readWindowsInstallationId,
};
