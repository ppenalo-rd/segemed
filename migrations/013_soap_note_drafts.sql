BEGIN;

CREATE TABLE IF NOT EXISTS soap_note_drafts (
    id BIGSERIAL PRIMARY KEY,
    patient_id INTEGER NOT NULL REFERENCES patients(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    consultation_id INTEGER REFERENCES medical_consultations(id),
    draft_data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT soap_note_drafts_object_check
        CHECK (jsonb_typeof(draft_data) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS soap_note_drafts_new_consultation_idx
    ON soap_note_drafts (patient_id, user_id)
    WHERE consultation_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS soap_note_drafts_existing_consultation_idx
    ON soap_note_drafts (patient_id, user_id, consultation_id)
    WHERE consultation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS soap_note_drafts_updated_at_idx
    ON soap_note_drafts (updated_at);

COMMIT;
