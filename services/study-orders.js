const VALID_PRIORITIES = new Set(['routine', 'urgent', 'stat']);

function normalizeStudyOrderInput(input) {
  const rawStudyIds = input.study_ids === undefined
    ? []
    : Array.isArray(input.study_ids) ? input.study_ids : [input.study_ids];
  if (rawStudyIds.length > 20) {
    throw new Error('Puedes seleccionar hasta 20 estudios por evolución.');
  }

  const studyIds = [];
  for (const rawId of rawStudyIds) {
    const value = String(rawId).trim();
    if (!/^[1-9]\d*$/.test(value)
        || !Number.isSafeInteger(Number(value))
        || Number(value) > 2147483647) {
      throw new Error('La selección de estudios contiene un identificador no válido.');
    }
    const id = Number(value);
    if (!studyIds.includes(id)) studyIds.push(id);
  }

  const priority = String(input.study_priority || 'routine').trim().toLowerCase();
  if (!VALID_PRIORITIES.has(priority)) {
    throw new Error('La prioridad de la orden de estudio no es válida.');
  }

  const instructions = String(input.study_instructions || '').trim();
  if (instructions.length > 1000) {
    throw new Error('Las indicaciones para las órdenes no pueden superar 1000 caracteres.');
  }

  return { studyIds, priority, instructions: instructions || null };
}

module.exports = { normalizeStudyOrderInput };
