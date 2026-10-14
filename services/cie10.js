const CIE10_SEARCH_SQL = `SELECT id, code, description
       FROM cie_catalog
       WHERE code ILIKE $3 ESCAPE '\\'
          OR description ILIKE $3 ESCAPE '\\'
       ORDER BY CASE
                  WHEN code ILIKE $1 ESCAPE '\\' THEN 0
                  WHEN description ILIKE $2 ESCAPE '\\' THEN 1
                  ELSE 2
                END,
                code
       LIMIT 12`;

function escapeLikeTerm(term) {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function normalizeCie10SearchTerm(value) {
  const term = typeof value === 'string' ? value.trim() : '';
  if (term.length < 2 || term.length > 80) {
    const error = new Error('Escribe entre 2 y 80 caracteres para buscar un código CIE-10.');
    error.name = 'InvalidCie10SearchError';
    throw error;
  }
  return term;
}

async function searchCie10(client, value) {
  const term = normalizeCie10SearchTerm(value);
  const escapedTerm = escapeLikeTerm(term);
  const pattern = `%${escapedTerm}%`;
  const { rows } = await client.query(CIE10_SEARCH_SQL, [
    `${escapedTerm}%`,
    `${escapedTerm}%`,
    pattern,
  ]);
  return rows;
}

async function lookupDiagnosisCodes(client, diagnosisCodes) {
  const { rows } = await client.query(
    'SELECT id, code, description FROM cie_catalog WHERE upper(code) = ANY($1::text[])',
    [diagnosisCodes.filter(Boolean)]
  );
  const diagnosisByCode = new Map(rows.map((row) => [row.code.toUpperCase(), row]));
  const unknownCodes = diagnosisCodes.filter((code) => code && !diagnosisByCode.has(code));
  return { diagnosisByCode, unknownCodes };
}

module.exports = {
  CIE10_SEARCH_SQL,
  lookupDiagnosisCodes,
  normalizeCie10SearchTerm,
  searchCie10,
};
