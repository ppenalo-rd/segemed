const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSoapAuditChanges,
  isSoapEditWindowOpen,
} = require('../services/soap-audit');

test('registra únicamente los campos SOAP cuyo valor cambió', () => {
  const changes = buildSoapAuditChanges(
    { chief_complaint: 'Dolor leve', cie10_primary_code: 'R51', objective: null },
    { chief_complaint: 'Dolor intenso', cie10_primary_code: 'R51', objective: 'Examen normal' }
  );

  assert.deepEqual(changes, [
    {
      fieldName: 'motivo_consulta',
      previousValue: 'Dolor leve',
      newValue: 'Dolor intenso',
    },
    {
      fieldName: 'objetivo_examen_fisico',
      previousValue: null,
      newValue: 'Examen normal',
    },
  ]);
});

test('autoriza la edición solo durante las primeras 24 horas desde created_at según PostgreSQL', () => {
  const databaseNow = new Date('2026-10-13T18:00:00.000Z');
  assert.equal(
    isSoapEditWindowOpen('2026-10-12T18:00:00.001Z', databaseNow),
    true
  );
  assert.equal(
    isSoapEditWindowOpen('2026-10-12T18:00:00.000Z', databaseNow),
    false
  );
  assert.equal(
    isSoapEditWindowOpen('2026-10-13T18:00:00.001Z', databaseNow),
    false
  );
  assert.equal(isSoapEditWindowOpen('fecha-inválida', databaseNow), false);
});
