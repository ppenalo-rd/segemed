const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const {
  createClinicalLicenseGuard,
  createLicenseRuntime,
} = require('../services/license-runtime');

const installationId = 'sigemed-runtime-test-01';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');

function createSignedLicense() {
  const payload = {
    version: 1,
    product: 'SIGEMED',
    licenseId: 'lic-runtime-test-01',
    installationId,
    durationDays: 30,
    activatedAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-10-31T00:00:00.000Z',
  };
  const signature = sign(
    null,
    Buffer.from(JSON.stringify(payload)),
    privateKey
  ).toString('base64url');
  return { payload, signature };
}

test('el runtime de desarrollo permite escrituras con estado explícito', () => {
  const runtime = createLicenseRuntime({ enforcementEnabled: false });
  assert.equal(runtime.getStatus().status, 'active');
  assert.equal(runtime.getStatus().reason, 'development_mode');
});

test('el enforcement queda en solo lectura si no hay configuración/licencia', async () => {
  const runtime = createLicenseRuntime({
    enforcementEnabled: true,
    installationId: 'sigemed-test-pc-01',
  });
  const status = await runtime.refresh();
  assert.equal(status.status, 'read_only');
  assert.equal(status.reason, 'license_public_key_unavailable');
});

test('instala una licencia firmada y cambia a solo lectura por vencimiento o retroceso', async () => {
  let currentTime = new Date('2026-10-02T00:00:00.000Z');
  let storedLicense = null;
  let storedState = null;
  const stateStore = {
    async load() { return storedState; },
    async save(state) { storedState = state; },
  };
  const licenseStore = {
    async loadLicense() { return storedLicense; },
    async saveLicense(content) { storedLicense = content; },
  };
  const runtime = createLicenseRuntime({
    licenseStore,
    stateStore,
    publicKey,
    installationId,
    now: () => currentTime,
  });

  const license = createSignedLicense();
  const status = await runtime.installLicense(JSON.stringify(license));
  assert.equal(status.status, 'active');
  assert.deepEqual(JSON.parse(storedLicense), license);
  assert.equal(storedState.lastSeenAt, currentTime.toISOString());

  currentTime = new Date('2026-10-01T23:59:59.000Z');
  assert.equal(runtime.getStatus().reason, 'clock_rollback');

  currentTime = new Date('2026-10-31T00:00:00.000Z');
  const restartedRuntime = createLicenseRuntime({
    licenseStore,
    stateStore,
    publicKey,
    installationId,
    now: () => currentTime,
  });
  await restartedRuntime.refresh();
  assert.equal(restartedRuntime.getStatus().reason, 'expired');
});

test('el guard deja pasar solo estados activos y responde 423 en JSON', () => {
  let status = { status: 'active', reason: 'valid' };
  const guard = createClinicalLicenseGuard(() => ({ getStatus: () => status }));
  let passed = false;
  guard({ is: () => false, get: () => undefined }, {}, () => { passed = true; });
  assert.equal(passed, true);

  status = {
    status: 'read_only',
    reason: 'expired',
    license: { expiresAt: '2026-10-31T00:00:00.000Z' },
  };
  let responseStatus;
  let body;
  const response = {
    set(name, value) {
      assert.equal(name, 'Cache-Control');
      assert.equal(value, 'no-store');
      return this;
    },
    status(code) {
      responseStatus = code;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };
  guard({ is: () => true, get: () => undefined }, response, () => {
    assert.fail('no debe permitir escrituras con licencia vencida');
  });
  assert.equal(responseStatus, 423);
  assert.deepEqual(body, {
    error: 'license_read_only',
    reason: 'expired',
    expiresAt: '2026-10-31T00:00:00.000Z',
  });
});

test('el guard muestra la vista de bloqueo en solicitudes HTML', () => {
  const status = { status: 'read_only', reason: 'missing_license', license: null };
  const guard = createClinicalLicenseGuard(() => ({ getStatus: () => status }));
  let rendered;
  const response = {
    set() { return this; },
    status(code) {
      assert.equal(code, 423);
      return this;
    },
    render(view, locals) {
      rendered = { view, locals };
      return this;
    },
  };
  guard({
    is: () => false,
    get: () => undefined,
    session: { user: { roles: ['system_admin'] } },
  }, response, () => assert.fail('no debe permitir escrituras sin licencia'));
  assert.equal(rendered.view, 'license_locked');
  assert.equal(rendered.locals.licenseStatus.reason, 'missing_license');
  assert.equal(rendered.locals.isSystemAdmin, true);
});
