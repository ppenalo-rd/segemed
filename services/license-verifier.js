const { verify } = require('node:crypto');

const LICENSE_PRODUCT = 'SIGEMED';
const LICENSE_DURATIONS_DAYS = Object.freeze([30, 60, 90, 120, 150, 180, 365]);
const LICENSE_FIELDS = Object.freeze([
  'version',
  'product',
  'licenseId',
  'installationId',
  'durationDays',
  'activatedAt',
  'expiresAt',
]);
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_LICENSE_BYTES = 16 * 1024;
const stateStoreLocks = new WeakMap();

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, expectedKeys) {
  return Object.keys(value).length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function isCanonicalUtcTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function parseLicenseEnvelope(license) {
  if (typeof license === 'string') {
    if (Buffer.byteLength(license, 'utf8') > MAX_LICENSE_BYTES) return null;
    try {
      license = JSON.parse(license);
    } catch {
      return null;
    }
  }
  if (!isRecord(license) || !hasOnlyKeys(license, ['payload', 'signature'])) return null;
  if (!isRecord(license.payload) || !hasOnlyKeys(license.payload, LICENSE_FIELDS)) return null;
  if (typeof license.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(license.signature)) {
    return null;
  }

  const signature = Buffer.from(license.signature, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== license.signature) return null;
  return { payload: license.payload, signature };
}

function serializeLicensePayload(payload) {
  return JSON.stringify(Object.fromEntries(LICENSE_FIELDS.map((field) => [field, payload[field]])));
}

function validateLicensePayload(payload, installationId) {
  if (payload.version !== 1 || payload.product !== LICENSE_PRODUCT) return 'unsupported_license';
  if (typeof payload.licenseId !== 'string'
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(payload.licenseId)) return 'invalid_license';
  if (typeof payload.installationId !== 'string'
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(payload.installationId)) return 'invalid_license';
  if (payload.installationId !== installationId) return 'installation_mismatch';
  if (!Number.isInteger(payload.durationDays)
      || !LICENSE_DURATIONS_DAYS.includes(payload.durationDays)) return 'invalid_duration';
  if (!isCanonicalUtcTimestamp(payload.activatedAt) || !isCanonicalUtcTimestamp(payload.expiresAt)) {
    return 'invalid_timestamp';
  }
  const expectedExpiry = Date.parse(payload.activatedAt)
    + payload.durationDays * MILLISECONDS_PER_DAY;
  if (Date.parse(payload.expiresAt) !== expectedExpiry) return 'invalid_expiry';
  return null;
}

function validateStoredState(state, installationId) {
  if (!isRecord(state)
      || !hasOnlyKeys(state, ['version', 'installationId', 'lastSeenAt'])
      || state.version !== 1
      || state.installationId !== installationId
      || !isCanonicalUtcTimestamp(state.lastSeenAt)) {
    return false;
  }
  return true;
}

function result(status, reason, payload, now) {
  return {
    status,
    reason,
    license: payload ? {
      licenseId: payload.licenseId,
      durationDays: payload.durationDays,
      activatedAt: payload.activatedAt,
      expiresAt: payload.expiresAt,
      daysRemaining: Math.max(0, Math.ceil((Date.parse(payload.expiresAt) - now) / MILLISECONDS_PER_DAY)),
    } : null,
  };
}

async function withStateStoreLock(stateStore, operation) {
  const previous = stateStoreLocks.get(stateStore) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  stateStoreLocks.set(stateStore, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (stateStoreLocks.get(stateStore) === current) stateStoreLocks.delete(stateStore);
  }
}

/**
 * Verifies a signed SIGEMED license and updates an injected protected monotonic-time store.
 * The state store must persist data securely and atomically; storage errors intentionally propagate.
 */
async function verifyLocalLicense({
  license,
  publicKey,
  installationId,
  stateStore,
  now = new Date(),
}) {
  const currentTime = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(currentTime)) return result('read_only', 'invalid_clock', null, 0);
  if (typeof installationId !== 'string'
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(installationId)) {
    throw new TypeError('installationId contiene caracteres no válidos o supera 128 caracteres.');
  }
  if (!publicKey) throw new TypeError('Se requiere la clave pública del emisor de licencias.');
  if (!stateStore || typeof stateStore.load !== 'function' || typeof stateStore.save !== 'function') {
    throw new TypeError('Se requiere un almacén protegido de estado de licencia.');
  }

  const envelope = parseLicenseEnvelope(license);
  if (!envelope) return result('read_only', 'invalid_license', null, currentTime);

  const payloadError = validateLicensePayload(envelope.payload, installationId);
  if (payloadError) return result('read_only', payloadError, null, currentTime);

  const isSignatureValid = verify(
    null,
    Buffer.from(serializeLicensePayload(envelope.payload), 'utf8'),
    publicKey,
    envelope.signature
  );
  if (!isSignatureValid) return result('read_only', 'invalid_signature', null, currentTime);

  return withStateStoreLock(stateStore, async () => {
    const state = await stateStore.load();
    if (state !== null && !validateStoredState(state, installationId)) {
      return result('read_only', 'invalid_clock_state', envelope.payload, currentTime);
    }
    if (state && currentTime < Date.parse(state.lastSeenAt)) {
      return result('read_only', 'clock_rollback', envelope.payload, currentTime);
    }

    const currentTimestamp = new Date(currentTime).toISOString();
    await stateStore.save({
      version: 1,
      installationId,
      lastSeenAt: currentTimestamp,
    });

    if (currentTime < Date.parse(envelope.payload.activatedAt)) {
      return result('read_only', 'not_yet_active', envelope.payload, currentTime);
    }
    if (currentTime >= Date.parse(envelope.payload.expiresAt)) {
      return result('read_only', 'expired', envelope.payload, currentTime);
    }
    return result('active', 'valid', envelope.payload, currentTime);
  });
}

module.exports = {
  LICENSE_DURATIONS_DAYS,
  LICENSE_PRODUCT,
  verifyLocalLicense,
};
