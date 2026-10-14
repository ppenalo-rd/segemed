const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync, sign } = require('node:crypto');
const { createWindowsLicenseStateStore } = require('../services/windows-license-state-store');
const { verifyLocalLicense } = require('../services/license-verifier');

test('el almacén Windows rechaza rutas no absolutas y estados fuera de esquema', async () => {
  assert.throws(
    () => createWindowsLicenseStateStore({ filePath: 'relative\\clock-state.bin' }),
    /ruta absoluta/
  );

  const stateStore = createWindowsLicenseStateStore({
    filePath: path.join(os.tmpdir(), 'SIGEMED-invalid-state.bin'),
  });
  assert.rejects(
    stateStore.save({ version: 1, installationId: 'pc-01', lastSeenAt: 'invalid' }),
    /formato admitido/
  );
});

test('persiste el marcador cifrado con DPAPI, sobrevive a una nueva instancia y falla cerrado ante corrupción', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sigemed-license-store-'));
  const filePath = path.join(directory, 'clock-state.bin');
  const state = {
    version: 1,
    installationId: 'sigemed-test-pc-01',
    lastSeenAt: '2026-10-14T12:00:00.000Z',
  };

  try {
    const firstStore = createWindowsLicenseStateStore({ filePath });
    assert.equal(await firstStore.load(), null);
    await firstStore.save(state);

    const encryptedFile = await fs.readFile(filePath, 'ascii');
    assert.match(encryptedFile, /^SIGEMED-DPAPI-STATE-v1\r?\n/);
    assert.equal(encryptedFile.includes(state.lastSeenAt), false);
    assert.equal(encryptedFile.includes(state.installationId), false);

    const restartedStore = createWindowsLicenseStateStore({ filePath });
    assert.deepEqual(await restartedStore.load(), state);
    await restartedStore.save({ ...state, lastSeenAt: '2026-10-15T12:00:00.000Z' });
    assert.equal((await restartedStore.load()).lastSeenAt, '2026-10-15T12:00:00.000Z');

    await fs.writeFile(filePath, 'SIGEMED-DPAPI-STATE-v1\r\nnot-valid-ciphertext', 'ascii');
    await assert.rejects(restartedStore.load(), /almacén DPAPI de licencias/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('persiste la licencia firmada cifrada con DPAPI entre instancias', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sigemed-license-file-'));
  const licensePath = path.join(directory, 'license.bin');
  const licenseContent = JSON.stringify({
    payload: { licenseId: 'lic-dpapi-test', durationDays: 30 },
    signature: 'firma-prueba',
  });

  try {
    const firstStore = createWindowsLicenseStateStore({
      filePath: path.join(directory, 'clock-state.bin'),
      licensePath,
    });
    await firstStore.saveLicense(licenseContent);
    const encryptedFile = await fs.readFile(licensePath, 'ascii');
    assert.match(encryptedFile, /^SIGEMED-DPAPI-LICENSE-v1\r?\n/);
    assert.equal(encryptedFile.includes(licenseContent), false);

    const restartedStore = createWindowsLicenseStateStore({
      filePath: path.join(directory, 'clock-state.bin'),
      licensePath,
    });
    assert.equal(await restartedStore.loadLicense(), licenseContent);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('el verificador detecta un retroceso usando el estado DPAPI tras recrear el adaptador', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sigemed-license-verifier-'));
  const filePath = path.join(directory, 'clock-state.bin');
  const installationId = 'sigemed-e2e-pc-01';
  const payload = {
    version: 1,
    product: 'SIGEMED',
    licenseId: 'lic-e2e-01',
    installationId,
    durationDays: 30,
    activatedAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-10-31T00:00:00.000Z',
  };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signature = sign(
    null,
    Buffer.from(JSON.stringify(payload)),
    privateKey
  ).toString('base64url');
  const license = { payload, signature };

  try {
    const activeOutcome = await verifyLocalLicense({
      license,
      publicKey,
      installationId,
      stateStore: createWindowsLicenseStateStore({ filePath }),
      now: new Date('2026-10-14T12:00:00.000Z'),
    });
    assert.equal(activeOutcome.status, 'active');

    const rollbackOutcome = await verifyLocalLicense({
      license,
      publicKey,
      installationId,
      stateStore: createWindowsLicenseStateStore({ filePath }),
      now: new Date('2026-10-14T11:59:59.999Z'),
    });
    assert.equal(rollbackOutcome.status, 'read_only');
    assert.equal(rollbackOutcome.reason, 'clock_rollback');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
