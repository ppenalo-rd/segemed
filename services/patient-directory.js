const PATIENT_DIRECTORY_PAGE_SIZE = 50;
const MAX_PATIENT_DIRECTORY_PAGE = 1000;
const MIN_PATIENT_DIRECTORY_QUERY_LENGTH = 3;
const MAX_PATIENT_DIRECTORY_QUERY_LENGTH = 80;

function normalizePatientDirectoryFilters(query) {
  const search = String(query.search || '').trim();
  if (search && search.length < MIN_PATIENT_DIRECTORY_QUERY_LENGTH) {
    throw new Error('Escribe al menos 3 caracteres para buscar.');
  }
  if (search.length > MAX_PATIENT_DIRECTORY_QUERY_LENGTH) {
    throw new Error('La búsqueda no puede superar 80 caracteres.');
  }

  const rawPage = String(query.page || '1');
  if (!/^[1-9]\d*$/.test(rawPage) || Number(rawPage) > MAX_PATIENT_DIRECTORY_PAGE) {
    throw new Error('El número de página no es válido.');
  }

  return { search, page: Number(rawPage) };
}

async function searchPatientDirectory(client, { search, page }) {
  const values = [];
  let whereClause = '';
  if (search) {
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    values.push(pattern);
    whereClause = `
      WHERE dni_document ILIKE $1 ESCAPE '\\'
         OR medical_record_number ILIKE $1 ESCAPE '\\'
         OR first_name ILIKE $1 ESCAPE '\\'
         OR last_name ILIKE $1 ESCAPE '\\'`;
  }

  const limitParameter = values.length + 1;
  const offsetParameter = values.length + 2;
  values.push(PATIENT_DIRECTORY_PAGE_SIZE + 1, (page - 1) * PATIENT_DIRECTORY_PAGE_SIZE);

  const { rows } = await client.query(
    `SELECT id, dni_document, document_type, first_name, last_name, birth_date,
            gender, phone, email, medical_record_number
     FROM patients
     ${whereClause}
     ORDER BY created_at DESC, id DESC
     LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
    values
  );

  const hasNextPage = rows.length > PATIENT_DIRECTORY_PAGE_SIZE;
  if (hasNextPage) rows.pop();
  return { patients: rows, hasNextPage };
}

module.exports = {
  MAX_PATIENT_DIRECTORY_PAGE,
  PATIENT_DIRECTORY_PAGE_SIZE,
  MIN_PATIENT_DIRECTORY_QUERY_LENGTH,
  normalizePatientDirectoryFilters,
  searchPatientDirectory,
};
