const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PATIENT_DIRECTORY_PAGE_SIZE,
  normalizePatientDirectoryFilters,
  searchPatientDirectory,
} = require('../services/patient-directory');

test('normaliza filtros y limita la paginación del directorio', () => {
  assert.deepEqual(normalizePatientDirectoryFilters({ search: ' HMC-10000 ', page: '2' }), {
    search: 'HMC-10000',
    page: 2,
  });
  assert.deepEqual(normalizePatientDirectoryFilters({}), { search: '', page: 1 });
  assert.throws(() => normalizePatientDirectoryFilters({ search: 'ab' }), /3 caracteres/);
  assert.throws(() => normalizePatientDirectoryFilters({ page: '0' }), /página/);
  assert.throws(() => normalizePatientDirectoryFilters({ page: '1001' }), /página/);
  assert.throws(() => normalizePatientDirectoryFilters({ search: 'x'.repeat(81) }), /80 caracteres/);
});

test('busca por documento, HMC, nombre y apellido con parámetros escapados y devuelve página acotada', async () => {
  let queryCall;
  const rows = Array.from({ length: PATIENT_DIRECTORY_PAGE_SIZE + 1 }, (_, index) => ({ id: index + 1 }));
  const result = await searchPatientDirectory({
    async query(sql, values) {
      queryCall = { sql, values };
      return { rows };
    },
  }, { search: 'V-84_%', page: 2 });

  assert.match(queryCall.sql, /dni_document ILIKE/);
  assert.match(queryCall.sql, /medical_record_number ILIKE/);
  assert.match(queryCall.sql, /first_name ILIKE/);
  assert.match(queryCall.sql, /last_name ILIKE/);
  assert.doesNotMatch(queryCall.sql, /concat_ws/);
  assert.match(queryCall.sql, /LIMIT \$2 OFFSET \$3/);
  assert.deepEqual(queryCall.values, ['%V-84\\_\\%%', PATIENT_DIRECTORY_PAGE_SIZE + 1, PATIENT_DIRECTORY_PAGE_SIZE]);
  assert.equal(result.patients.length, PATIENT_DIRECTORY_PAGE_SIZE);
  assert.equal(result.hasNextPage, true);
});

test('lista pacientes sin filtro en páginas deterministas y acotadas', async () => {
  let queryCall;
  const result = await searchPatientDirectory({
    async query(sql, values) {
      queryCall = { sql, values };
      return { rows: [{ id: 1 }] };
    },
  }, { search: '', page: 1 });

  assert.doesNotMatch(queryCall.sql, /WHERE/);
  assert.match(queryCall.sql, /ORDER BY created_at DESC, id DESC/);
  assert.deepEqual(queryCall.values, [PATIENT_DIRECTORY_PAGE_SIZE + 1, 0]);
  assert.equal(result.hasNextPage, false);
});
