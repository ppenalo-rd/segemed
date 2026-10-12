const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeStudyOrderInput } = require('../services/study-orders');

test('normaliza y deduplica estudios y aplica valores por defecto', () => {
  assert.deepEqual(normalizeStudyOrderInput({ study_ids: ['2', '2', '9'] }), {
    studyIds: [2, 9],
    priority: 'routine',
    instructions: null,
  });
});

test('acepta un solo estudio y normaliza prioridad e indicaciones', () => {
  assert.deepEqual(normalizeStudyOrderInput({
    study_ids: '4',
    study_priority: 'URGENT',
    study_instructions: '  Ayuno según protocolo local  ',
  }), {
    studyIds: [4],
    priority: 'urgent',
    instructions: 'Ayuno según protocolo local',
  });
});

test('rechaza identificadores, prioridades, indicaciones y volúmenes inválidos', () => {
  assert.throws(() => normalizeStudyOrderInput({ study_ids: ['0'] }), /identificador/);
  assert.throws(() => normalizeStudyOrderInput({ study_ids: ['2147483648'] }), /identificador/);
  assert.throws(() => normalizeStudyOrderInput({ study_priority: 'emergency' }), /prioridad/);
  assert.throws(() => normalizeStudyOrderInput({ study_instructions: 'x'.repeat(1001) }), /1000/);
  assert.throws(() => normalizeStudyOrderInput({
    study_ids: Array.from({ length: 21 }, (_, index) => String(index + 1)),
  }), /20 estudios/);
});
