const DIAGNOSIS_FIELDS = [
  ['cie10_primary_code', 'cie10_code'],
  ['cie10_secondary_code', null],
  ['cie10_tertiary_code', null],
];

function parseLegacyCie10Reference(assessment) {
  const text = typeof assessment === 'string' ? assessment : '';
  const marker = '| Ref. CIE-10:';
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex < 0) return { assessment: text, code: '', description: '' };

  const cleanAssessment = text.slice(0, markerIndex).trim();
  const reference = text.slice(markerIndex + marker.length).trim();
  const match = reference.match(/^([A-Z][A-Z0-9.]{2,59})\s*[-—]\s*(.+)$/i);
  return {
    assessment: cleanAssessment,
    code: match ? match[1].toUpperCase() : '',
    description: match ? match[2].trim() : '',
  };
}

function formatDiagnosisLabel(code, description) {
  const normalizedCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!normalizedCode) return '';
  const normalizedDescription = typeof description === 'string' ? description.trim() : '';
  return normalizedDescription ? `${normalizedCode} — ${normalizedDescription}` : normalizedCode;
}

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

module.exports = {
  formatDiagnosisLabel,
  normalizeDiagnosisCodes,
  parseLegacyCie10Reference,
};
