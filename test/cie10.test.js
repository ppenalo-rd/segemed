const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CIE10_SEARCH_SQL,
  lookupDiagnosisCodes,
  normalizeCie10SearchTerm,
  searchCie10,
} = require('../services/cie10');
const {
  formatDiagnosisLabel,
  normalizeDiagnosisCodes,
  parseLegacyCie10Reference,
} = require('../services/clinical-note');
const {
  canonicalizeCie10Selection,
  formatCie10Diagnosis,
  isCurrentSearchResponse,
} = require('../public/js/cie10-autocomplete');

test('busca CIE-10 con término escapado, consulta parametrizada y límite de 12', async () => {
  let queryCall;
  const client = {
    async query(sql, parameters) {
      queryCall = { sql, parameters };
      return { rows: [{ id: 1, code: 'A00', description: 'Diagnóstico de prueba' }] };
    },
  };

  const rows = await searchCie10(client, ' A_%\\ ');

  assert.equal(rows[0].code, 'A00');
  assert.equal(queryCall.sql, CIE10_SEARCH_SQL);
  assert.match(queryCall.sql, /ORDER BY CASE/);
  assert.match(queryCall.sql, /LIMIT 12/);
  assert.deepEqual(queryCall.parameters, [
    'A\\_\\%\\\\%',
    'A\\_\\%\\\\%',
    '%A\\_\\%\\\\%',
  ]);
  assert.equal(normalizeCie10SearchTerm('  I10  '), 'I10');
});

test('selección canónica resuelve el código CIE-10 al registro persistible del catálogo', async () => {
  const selected = canonicalizeCie10Selection({
    id: 77,
    code: 'i10',
    description: 'Hipertensión esencial',
  });
  assert.deepEqual(selected, {
    id: 77,
    code: 'I10',
    description: 'Hipertensión esencial',
  });
  assert.equal(formatCie10Diagnosis(selected), 'I10 - Hipertensión esencial');

  const diagnosisCodes = normalizeDiagnosisCodes({ cie10_primary_code: selected.code });
  const catalog = await lookupDiagnosisCodes({
    async query(sql, parameters) {
      assert.match(sql, /upper\(code\) = ANY/);
      assert.deepEqual(parameters, [['I10']]);
      return {
        rows: [{ id: selected.id, code: 'I10', description: selected.description }],
      };
    },
  }, diagnosisCodes);

  assert.equal(catalog.diagnosisByCode.get('I10').id, 77);
  assert.deepEqual(catalog.unknownCodes, []);
});

test('rechaza búsquedas, selecciones y diagnósticos inválidos o ausentes del catálogo', async () => {
  let databaseCalls = 0;
  const client = {
    async query() {
      databaseCalls += 1;
      return { rows: [] };
    },
  };

  for (const invalidQuery of [undefined, 42, ' ', 'I', 'x'.repeat(81)]) {
    await assert.rejects(searchCie10(client, invalidQuery), { name: 'InvalidCie10SearchError' });
  }
  assert.equal(databaseCalls, 0);
  assert.equal(canonicalizeCie10Selection({ id: 0, code: 'I10', description: 'Hipertensión' }), null);
  assert.equal(canonicalizeCie10Selection({ id: 77, code: 'I 10', description: 'Hipertensión' }), null);
  assert.throws(
    () => normalizeDiagnosisCodes({ cie10_primary_code: 'I 10' }),
    /formato/
  );

  const unknown = await lookupDiagnosisCodes(client, ['I10', '', '']);
  assert.deepEqual(unknown.unknownCodes, ['I10']);
  assert.equal(databaseCalls, 1);
});

test('descarta respuestas CIE-10 obsoletas por secuencia o consulta distinta', () => {
  assert.equal(isCurrentSearchResponse(4, 4, 'hiper', 'hiper'), true);
  assert.equal(isCurrentSearchResponse(3, 4, 'hiper', 'hiper'), false);
  assert.equal(isCurrentSearchResponse(4, 4, 'hiper', 'hipertensión'), false);
});

test('formatea los diagnósticos para lectura e identifica referencias SOAP legadas sin dividir por guiones', () => {
  assert.equal(
    formatDiagnosisLabel('g501', 'Dolor Facial Atípico - persistente'),
    'G501 — Dolor Facial Atípico - persistente'
  );
  assert.deepEqual(
    parseLegacyCie10Reference('Evaluación clínica | Ref. CIE-10: G501 - Dolor Facial Atípico'),
    {
      assessment: 'Evaluación clínica',
      code: 'G501',
      description: 'Dolor Facial Atípico',
    }
  );
  assert.deepEqual(
    parseLegacyCie10Reference('Evaluación clínica | Ref. CIE-10: d'),
    { assessment: 'Evaluación clínica', code: '', description: '' }
  );
  assert.deepEqual(
    parseLegacyCie10Reference('Evaluación clínica'),
    { assessment: 'Evaluación clínica', code: '', description: '' }
  );
});
