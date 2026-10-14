const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSoapAuditChanges,
  hashSoapEditPayload,
  isSoapEditWindowOpen,
  normalizeSoapEditPayload,
} = require('../services/soap-audit');

test('normaliza y firma de forma estable únicamente los campos SOAP autorizados', () => {
  const first = {
    chief_complaint: 'Dolor',
    assessment: 'Evaluación',
    unrelated_field: 'ignored',
  };
  const second = {
    assessment: 'Evaluación',
    chief_complaint: 'Dolor',
    unrelated_field: 'changed but ignored',
  };

  assert.deepEqual(normalizeSoapEditPayload(first), normalizeSoapEditPayload(second));
  assert.equal(hashSoapEditPayload(first), hashSoapEditPayload(second));
});

test('rechaza tipos inesperados y campos SOAP demasiado extensos antes de firmar', () => {
  assert.throws(() => normalizeSoapEditPayload({ assessment: ['no válido'] }), /formato válido/);
  assert.throws(() => normalizeSoapEditPayload({ assessment: 'x'.repeat(10001) }), /tamaño permitido/);
});

test('normaliza saltos de línea para mantener estable la firma entre JSON y formularios HTML', () => {
  assert.equal(
    hashSoapEditPayload({ assessment: 'Línea uno\nLínea dos' }),
    hashSoapEditPayload({ assessment: 'Línea uno\r\nLínea dos' })
  );
});

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

test('autoriza la edición hasta antes de cumplirse 24 horas según la hora de PostgreSQL', () => {
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

test('el OTP cubre el mismo contenido clínico que recibe el formulario de guardado', () => {
  const requestedPayload = {
    chief_complaint: 'Dolor abdominal',
    assessment: '',
    study_ids: ['12', '4'],
    study_instructions: 'Ayuno de 8 horas',
    not_a_soap_field: 'ignorado al guardar',
  };
  const submittedForm = {
    ...requestedPayload,
    study_ids: ['4', '12'],
    soap_edit_challenge_id: 'no forma parte de la nota',
  };

  assert.equal(hashSoapEditPayload(requestedPayload), hashSoapEditPayload(submittedForm));
  assert.notEqual(
    hashSoapEditPayload(requestedPayload),
    hashSoapEditPayload({ ...submittedForm, assessment: 'Completar análisis' })
  );
});
