const SOAP_EDIT_WINDOW_HOURS = 24;

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

function isSoapEditWindowOpen(createdAt, databaseNow, windowHours = SOAP_EDIT_WINDOW_HOURS) {
  const createdTime = new Date(createdAt).getTime();
  const currentTime = new Date(databaseNow).getTime();
  return Number.isFinite(createdTime)
    && Number.isFinite(currentTime)
    && createdTime <= currentTime
    && currentTime - createdTime < windowHours * 60 * 60 * 1000;
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
  buildSoapAuditChanges,
  isSoapEditWindowOpen,
};
