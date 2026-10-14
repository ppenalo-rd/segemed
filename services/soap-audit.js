const crypto = require('node:crypto');

const SOAP_EDIT_WINDOW_HOURS = 24;

const SOAP_EDIT_FIELDS = [
  'chief_complaint',
  'current_illness',
  'relevant_background',
  'blood_pressure',
  'heart_rate',
  'temperature',
  'weight',
  'height',
  'respiratory_rate',
  'oxygen_saturation',
  'objective',
  'lab_results_summary',
  'assessment',
  'cie10_primary_code',
  'cie10_secondary_code',
  'cie10_tertiary_code',
  'diagnostic_plan',
  'therapeutic_plan',
  'plan',
  'education_recommendations',
  'follow_up_date',
  'study_priority',
  'study_instructions',
  'study_ids',
];

const SOAP_AUDIT_FIELD_NAMES = {
  chief_complaint: 'motivo_consulta',
  current_illness: 'enfermedad_actual',
  relevant_background: 'antecedentes_relevantes',
  blood_pressure: 'presion_arterial',
  heart_rate: 'frecuencia_cardiaca',
  temperature: 'temperatura',
  weight: 'peso',
  height: 'talla',
  respiratory_rate: 'frecuencia_respiratoria',
  oxygen_saturation: 'saturacion_oxigeno',
  objective: 'objetivo_examen_fisico',
  lab_results_summary: 'resultados_laboratorio',
  assessment: 'analisis_juicio_clinico',
  cie10_primary_code: 'diagnostico_principal',
  cie10_secondary_code: 'diagnostico_secundario',
  cie10_tertiary_code: 'diagnostico_terciario',
  diagnostic_plan: 'plan_diagnostico',
  therapeutic_plan: 'tratamiento_terapeutico',
  plan: 'plan_indicaciones',
  education_recommendations: 'educacion_recomendaciones',
  follow_up_date: 'fecha_seguimiento',
};

function normalizeSoapEditPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Los datos de la evolución no tienen un formato válido.');
  }
  const normalized = {};
  for (const field of SOAP_EDIT_FIELDS) {
    const fieldValue = value[field];
    if (field === 'study_ids') {
      const ids = fieldValue === undefined || fieldValue === ''
        ? []
        : Array.isArray(fieldValue) ? fieldValue : [fieldValue];
      if (ids.length > 100 || ids.some((id) => !/^[1-9]\d*$/.test(String(id)))) {
        throw new Error('La lista de estudios de la evolución no es válida.');
      }
      normalized[field] = [...new Set(ids.map(String))].sort();
      continue;
    }
    if (fieldValue !== undefined && typeof fieldValue !== 'string') {
      throw new Error(`El campo ${field} no tiene un formato válido.`);
    }
    if (fieldValue && fieldValue.length > 10000) {
      throw new Error(`El campo ${field} excede el tamaño permitido.`);
    }
    normalized[field] = fieldValue ? fieldValue.replace(/\r\n?/g, '\n') : '';
  }
  return normalized;
}

function hashSoapEditPayload(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(normalizeSoapEditPayload(value)))
    .digest('hex');
}

function isSoapEditWindowOpen(lastSavedAt, databaseNow, windowHours = SOAP_EDIT_WINDOW_HOURS) {
  const lastSavedTime = new Date(lastSavedAt).getTime();
  const currentTime = new Date(databaseNow).getTime();
  return Number.isFinite(lastSavedTime)
    && Number.isFinite(currentTime)
    && lastSavedTime <= currentTime
    && currentTime - lastSavedTime < windowHours * 60 * 60 * 1000;
}

function buildSoapAuditChanges(previousValues, nextValues) {
  return Object.keys(SOAP_AUDIT_FIELD_NAMES)
    .filter((field) => String(previousValues[field] ?? '') !== String(nextValues[field] ?? ''))
    .map((field) => ({
      fieldName: SOAP_AUDIT_FIELD_NAMES[field],
      previousValue: previousValues[field] ?? null,
      newValue: nextValues[field] || null,
    }));
}

module.exports = {
  SOAP_EDIT_WINDOW_HOURS,
  SOAP_EDIT_FIELDS,
  buildSoapAuditChanges,
  hashSoapEditPayload,
  isSoapEditWindowOpen,
  normalizeSoapEditPayload,
};
