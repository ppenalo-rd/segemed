const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMedication, normalizePrescriptionItems } = require('../services/prescription');

test('normaliza múltiples medicamentos de receta', () => {
  assert.deepEqual(normalizePrescriptionItems({
    items: [
      { medication_id: '3', dose: '1 tableta', frequency: 'cada 8 horas', quantity: '12' },
      { medication_name: 'Medicamento no catalogado', dose: '5 ml', frequency: 'cada 12 horas' },
    ],
  }), [
    {
      medicationId: 3,
      medicationName: '',
      strength: null,
      dose: '1 tableta',
      route: null,
      frequency: 'cada 8 horas',
      duration: null,
      quantity: '12',
      instructions: null,
    },
    {
      medicationId: null,
      medicationName: 'Medicamento no catalogado',
      strength: null,
      dose: '5 ml',
      route: null,
      frequency: 'cada 12 horas',
      duration: null,
      quantity: null,
      instructions: null,
    },
  ]);
});

test('rechaza receta vacía, posología incompleta, cantidad inválida e identificador inválido', () => {
  assert.throws(() => normalizePrescriptionItems({}), /al menos un medicamento/);
  assert.throws(() => normalizePrescriptionItems({ items: [{ medication_name: 'Medicamento', frequency: 'diaria' }] }), /dosis es obligatoria/);
  assert.throws(() => normalizePrescriptionItems({ items: [{ medication_name: 'Medicamento', dose: '1', frequency: 'diaria', quantity: '0' }] }), /cantidad/);
  assert.throws(() => normalizePrescriptionItems({ items: [{ medication_id: '2147483648', dose: '1', frequency: 'diaria' }] }), /identificador/);
  assert.throws(() => normalizePrescriptionItems({ items: Array.from({ length: 21 }, () => ({ medication_name: 'M', dose: '1', frequency: 'diaria' })) }), /20 medicamentos/);
});

test('normaliza y valida campos del catálogo local', () => {
  assert.deepEqual(normalizeMedication({
    code: 'MED-01',
    name: 'Medicamento',
    active_ingredient: 'Ingrediente',
    strength: '500 mg',
    dosage_form: 'Tableta',
    route: 'Oral',
  }), {
    code: 'MED-01',
    name: 'Medicamento',
    activeIngredient: 'Ingrediente',
    strength: '500 mg',
    dosageForm: 'Tableta',
    route: 'Oral',
  });
  assert.throws(() => normalizeMedication({ name: ' ' }), /nombre.*obligatorio/);
});
