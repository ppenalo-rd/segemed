const MAX_PRESCRIPTION_ITEMS = 20;

function normalizePrescriptionItems(input) {
  const rawItems = input.items === undefined
    ? []
    : Array.isArray(input.items) ? input.items : [input.items];
  if (!rawItems.length) throw new Error('Agrega al menos un medicamento a la receta.');
  if (rawItems.length > MAX_PRESCRIPTION_ITEMS) {
    throw new Error(`Puedes agregar hasta ${MAX_PRESCRIPTION_ITEMS} medicamentos por receta.`);
  }

  const items = rawItems.map((rawItem) => {
    const item = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const medicationId = String(item.medication_id || '').trim();
    if (medicationId && (!/^[1-9]\d*$/.test(medicationId)
        || !Number.isSafeInteger(Number(medicationId))
        || Number(medicationId) > 2147483647)) {
      throw new Error('La selección del catálogo contiene un identificador de medicamento no válido.');
    }

    const medicationName = String(item.medication_name || '').trim();
    const strength = String(item.strength || '').trim();
    const dose = String(item.dose || '').trim();
    const route = String(item.route || '').trim();
    const frequency = String(item.frequency || '').trim();
    const duration = String(item.duration || '').trim();
    const instructions = String(item.instructions || '').trim();
    const quantityInput = String(item.quantity || '').trim();

    if (medicationName.length > 180 || strength.length > 100 || dose.length > 100
        || route.length > 80 || frequency.length > 120 || duration.length > 100
        || instructions.length > 1000) {
      throw new Error('Uno o más campos de medicamento superan la longitud permitida.');
    }
    if (!medicationId && !medicationName) {
      throw new Error('Selecciona un medicamento del catálogo o escribe su nombre.');
    }
    if (!dose) throw new Error('La dosis es obligatoria para cada medicamento.');
    if (!frequency) throw new Error('La frecuencia es obligatoria para cada medicamento.');
    if (quantityInput && (!/^\d{1,8}(?:\.\d{1,2})?$/.test(quantityInput) || Number(quantityInput) <= 0)) {
      throw new Error('La cantidad debe ser un número mayor que cero con hasta dos decimales.');
    }

    return {
      medicationId: medicationId ? Number(medicationId) : null,
      medicationName,
      strength: strength || null,
      dose,
      route: route || null,
      frequency,
      duration: duration || null,
      quantity: quantityInput || null,
      instructions: instructions || null,
    };
  });
  const catalogMedicationIds = items.filter(item => item.medicationId).map(item => item.medicationId);
  if (new Set(catalogMedicationIds).size !== catalogMedicationIds.length) {
    throw new Error('No repitas un medicamento del catálogo en la misma receta.');
  }
  return items;
}

function normalizeMedication(input) {
  const medication = {
    code: String(input.code || '').trim(),
    name: String(input.name || '').trim(),
    activeIngredient: String(input.active_ingredient || '').trim(),
    strength: String(input.strength || '').trim(),
    dosageForm: String(input.dosage_form || '').trim(),
    route: String(input.route || '').trim(),
  };
  if (!medication.name) throw new Error('El nombre del medicamento es obligatorio.');
  if (medication.code.length > 80 || medication.name.length > 180
      || medication.activeIngredient.length > 180 || medication.strength.length > 100
      || medication.dosageForm.length > 100 || medication.route.length > 80) {
    throw new Error('Uno o más campos del medicamento superan la longitud permitida.');
  }
  return {
    ...medication,
    code: medication.code || null,
    activeIngredient: medication.activeIngredient || null,
    strength: medication.strength || null,
    dosageForm: medication.dosageForm || null,
    route: medication.route || null,
  };
}

module.exports = { normalizeMedication, normalizePrescriptionItems };
