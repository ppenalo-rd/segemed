const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const {
  LICENSE_DURATIONS_DAYS,
  LICENSE_PRODUCT,
  verifyLocalLicense,
} = require('../services/license-verifier');

const installationId = 'sigemed-pc-test-01';
const activatedAt = '2026-10-01T00:00:00.000Z';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');

function makeLicense(overrides = {}) {
  const payload = {
    version: 1,
    product: LICENSE_PRODUCT,
    licenseId: 'lic-test-001',
    installationId,
    durationDays: 30,
    activatedAt,
    expiresAt: '2026-10-31T00:00:00.000Z',
    ...overrides,
  };
  const canonicalPayload = JSON.stringify({
    version: payload.version,
    product: payload.product,
    licenseId: payload.licenseId,
    installationId: payload.installationId,
    durationDays: payload.durationDays,
    activatedAt: payload.activatedAt,
    expiresAt: payload.expiresAt,
  });
  const signature = sign(null, Buffer.from(canonicalPayload), privateKey).toString('base64url');
  return { payload, signature };
}

function createStateStore(initialState = null) {
  let state = initialState;
  return {
    async load() {
      return state;
    },
    async save(nextState) {
      state = nextState;
    },
    getState() {
      return state;
    },
  };
}

async function verify(license, { stateStore = createStateStore(), now, id = installationId } = {}) {
  return verifyLocalLicense({
    license,
    publicKey,
    installationId: id,
    stateStore,
    now: now ? new Date(now) : new Date('2026-10-02T00:00:00.000Z'),
  });
}

test('publica exactamente las siete duraciones comerciales aprobadas', () => {
  assert.deepEqual(LICENSE_DURATIONS_DAYS, [30, 60, 90, 120, 150, 180, 365]);
});

test('activa una licencia Ed25519 válida y persiste el marcador UTC', async () => {
  const stateStore = createStateStore();
  const outcome = await verify(makeLicense(), { stateStore });
  assert.equal(outcome.status, 'active');
  assert.equal(outcome.reason, 'valid');
  assert.equal(outcome.license.daysRemaining, 29);
  assert.deepEqual(stateStore.getState(), {
    version: 1,
    installationId,
    lastSeenAt: '2026-10-02T00:00:00.000Z',
  });
});

test('acepta como fechas de vencimiento los 7 plazos exactos', async () => {
  for (const durationDays of LICENSE_DURATIONS_DAYS) {
    const expiresAt = new Date(Date.parse(activatedAt) + durationDays * 86400000).toISOString();
    const outcome = await verify(makeLicense({ durationDays, expiresAt }));
    assert.equal(outcome.status, 'active', `duración ${durationDays}`);
  }
});

test('rechaza duraciones distintas de las opciones comerciales aun con firma válida', async () => {
  for (const durationDays of [0, 31, 181, 366, 30.5]) {
    const outcome = await verify(makeLicense({ durationDays }));
    assert.equal(outcome.reason, 'invalid_duration');
  }
});

test('rechaza firmas inválidas y payloads manipulados', async () => {
  const validLicense = makeLicense();
  const invalidSignature = { ...validLicense, signature: `${'A'.repeat(85)}A` };
  assert.equal((await verify(invalidSignature)).reason, 'invalid_signature');
  assert.equal((await verify({ ...validLicense, payload: { ...validLicense.payload, durationDays: 60 } })).reason,
    'invalid_expiry');
});

test('rechaza instalación distinta y producto o versión no soportados', async () => {
  assert.equal((await verify(makeLicense(), { id: 'otro-pc' })).reason, 'installation_mismatch');
  assert.equal((await verify(makeLicense({ product: 'OTRO' }))).reason, 'unsupported_license');
  assert.equal((await verify(makeLicense({ version: 2 }))).reason, 'unsupported_license');
});

test('rechaza vencimiento alterado aunque el emisor haya firmado el archivo', async () => {
  const license = makeLicense({ expiresAt: '2026-10-30T00:00:00.000Z' });
  assert.equal((await verify(license)).reason, 'invalid_expiry');
});

test('mantiene solo lectura antes de la activación y guarda el mayor instante válido', async () => {
  const stateStore = createStateStore();
  const outcome = await verify(makeLicense(), {
    stateStore,
    now: '2026-09-30T23:00:00.000Z',
  });
  assert.equal(outcome.status, 'read_only');
  assert.equal(outcome.reason, 'not_yet_active');
  assert.equal(stateStore.getState().lastSeenAt, '2026-09-30T23:00:00.000Z');
});

test('marca como vencida la licencia al llegar al instante de expiración', async () => {
  const outcome = await verify(makeLicense(), {
    now: '2026-10-31T00:00:00.000Z',
  });
  assert.equal(outcome.status, 'read_only');
  assert.equal(outcome.reason, 'expired');
});

test('detecta retroceso del reloj y no degrada el marcador persistido', async () => {
  const stateStore = createStateStore({
    version: 1,
    installationId,
    lastSeenAt: '2026-10-05T00:00:00.000Z',
  });
  const outcome = await verify(makeLicense(), {
    stateStore,
    now: '2026-10-04T23:59:59.999Z',
  });
  assert.equal(outcome.status, 'read_only');
  assert.equal(outcome.reason, 'clock_rollback');
  assert.equal(stateStore.getState().lastSeenAt, '2026-10-05T00:00:00.000Z');
});

test('falla en modo solo lectura ante un marcador persistido inválido', async () => {
  const outcome = await verify(makeLicense(), {
    stateStore: createStateStore({ version: 1, lastSeenAt: 'invalid' }),
  });
  assert.equal(outcome.status, 'read_only');
  assert.equal(outcome.reason, 'invalid_clock_state');
});

test('actualiza el marcador incluso al expirar para impedir reactivar con reloj atrasado', async () => {
  const stateStore = createStateStore();
  const outcome = await verify(makeLicense(), {
    stateStore,
    now: '2026-11-01T00:00:00.000Z',
  });
  assert.equal(outcome.reason, 'expired');
  assert.equal(stateStore.getState().lastSeenAt, '2026-11-01T00:00:00.000Z');
  const rollbackOutcome = await verify(makeLicense(), {
    stateStore,
    now: '2026-10-30T00:00:00.000Z',
  });
  assert.equal(rollbackOutcome.reason, 'clock_rollback');
});

test('no convierte fallos de almacenamiento en activación permisiva', async () => {
  const stateStore = {
    async load() {
      throw new Error('almacén indisponible');
    },
    async save() {},
  };
  await assert.rejects(
    verify(makeLicense(), { stateStore }),
    /almacén indisponible/
  );
});

test('serializa comprobaciones concurrentes para no retroceder el marcador', async () => {
  let activeOperations = 0;
  let maximumConcurrentOperations = 0;
  let state = null;
  const stateStore = {
    async load() {
      activeOperations += 1;
      maximumConcurrentOperations = Math.max(maximumConcurrentOperations, activeOperations);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeOperations -= 1;
      return state;
    },
    async save(nextState) {
      activeOperations += 1;
      maximumConcurrentOperations = Math.max(maximumConcurrentOperations, activeOperations);
      await new Promise((resolve) => setTimeout(resolve, 5));
      state = nextState;
      activeOperations -= 1;
    },
  };
  const outcomes = await Promise.all([
    verify(makeLicense(), { stateStore, now: '2026-10-03T00:00:00.000Z' }),
    verify(makeLicense(), { stateStore, now: '2026-10-04T00:00:00.000Z' }),
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ['active', 'active']);
  assert.equal(maximumConcurrentOperations, 1);
  assert.equal(state.lastSeenAt, '2026-10-04T00:00:00.000Z');
});
