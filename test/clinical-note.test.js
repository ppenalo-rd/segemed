const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDiagnosisCodes } = require('../services/clinical-note');

test('normaliza hasta tres diagnósticos CIE-10 en orden', () => {
  assert.deepEqual(normalizeDiagnosisCodes({
    cie10_primary_code: 'j00',
    cie10_secondary_code: 'R05',
    cie10_tertiary_code: 'E11.9',
  }), ['J00', 'R05', 'E11.9']);
});

test('conserva el código primario enviado por el formulario anterior', () => {
  assert.deepEqual(normalizeDiagnosisCodes({ cie10_code: 'j00' }), ['J00', '', '']);
});

test('rechaza diagnósticos fuera de orden, duplicados o con código inválido', () => {
  assert.throws(() => normalizeDiagnosisCodes({ cie10_secondary_code: 'R05' }), /principal/);
  assert.throws(() => normalizeDiagnosisCodes({
    cie10_primary_code: 'J00',
    cie10_secondary_code: 'J00',
  }), /distinto/);
  assert.throws(() => normalizeDiagnosisCodes({ cie10_primary_code: 'J 00' }), /formato/);
});
