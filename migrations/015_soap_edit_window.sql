BEGIN;

ALTER TABLE medical_consultations
    ADD COLUMN IF NOT EXISTS soap_last_saved_at TIMESTAMPTZ;

UPDATE medical_consultations
SET soap_last_saved_at = created_at
WHERE soap_last_saved_at IS NULL;

ALTER TABLE medical_consultations
    ALTER COLUMN soap_last_saved_at SET DEFAULT CURRENT_TIMESTAMP,
    ALTER COLUMN soap_last_saved_at SET NOT NULL;

COMMIT;
