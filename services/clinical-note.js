const DIAGNOSIS_FIELDS = [
  ['cie10_primary_code', 'cie10_code'],
  ['cie10_secondary_code', null],
  ['cie10_tertiary_code', null],
];

function normalizeDiagnosisCodes(body) {
  const codes = DIAGNOSIS_FIELDS.map(([field, legacyField]) =>
    String(body[field] || (legacyField ? body[legacyField] : '') || '').trim().toUpperCase()
  );
  const usedCodes = codes.filter(Boolean);

  if (codes[1] && !codes[0]) {
    throw new Error('Registra primero el diagnóstico principal.');
  }
  if (codes[2] && !codes[1]) {
    throw new Error('Registra el diagnóstico secundario antes del tercero.');
  }
  if (new Set(usedCodes).size !== usedCodes.length) {
    throw new Error('Cada diagnóstico debe tener un código CIE-10 distinto.');
  }
  if (usedCodes.some((code) => code.length > 60 || !/^[A-Z0-9.]+$/.test(code))) {
    throw new Error('Uno de los códigos CIE-10 tiene un formato no válido.');
  }

  return codes;
}

module.exports = { normalizeDiagnosisCodes };
