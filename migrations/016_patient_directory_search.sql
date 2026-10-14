BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS patients_document_trgm_idx
    ON patients USING GIN (dni_document gin_trgm_ops);
CREATE INDEX IF NOT EXISTS patients_medical_record_number_trgm_idx
    ON patients USING GIN (medical_record_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS patients_first_name_trgm_idx
    ON patients USING GIN (first_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS patients_last_name_trgm_idx
    ON patients USING GIN (last_name gin_trgm_ops);

COMMIT;
