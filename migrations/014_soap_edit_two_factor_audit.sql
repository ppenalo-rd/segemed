BEGIN;

CREATE TABLE IF NOT EXISTS soap_edit_otp_challenges (
    challenge_id UUID PRIMARY KEY,
    patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    consultation_id INTEGER NOT NULL REFERENCES medical_consultations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    otp_hash VARCHAR(64) NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    attempts SMALLINT NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    resend_after TIMESTAMPTZ NOT NULL,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT soap_edit_otp_attempts_check CHECK (attempts BETWEEN 0 AND 5),
    CONSTRAINT soap_edit_otp_payload_hash_check CHECK (payload_hash ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS soap_edit_otp_user_consultation_idx
    ON soap_edit_otp_challenges (user_id, consultation_id);

CREATE INDEX IF NOT EXISTS soap_edit_otp_expiry_idx
    ON soap_edit_otp_challenges (expires_at);

CREATE TABLE IF NOT EXISTS soap_audit_logs (
    id BIGSERIAL PRIMARY KEY,
    consultation_id INTEGER NOT NULL REFERENCES medical_consultations(id),
    field_name VARCHAR(100) NOT NULL,
    previous_value TEXT,
    new_value TEXT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    user_name VARCHAR(180) NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT,
    CONSTRAINT soap_audit_logs_changed_value_check
        CHECK (previous_value IS DISTINCT FROM new_value)
);

CREATE INDEX IF NOT EXISTS soap_audit_logs_consultation_time_idx
    ON soap_audit_logs (consultation_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS soap_audit_logs_user_time_idx
    ON soap_audit_logs (user_id, changed_at DESC);

DROP TRIGGER IF EXISTS soap_audit_logs_immutable ON soap_audit_logs;
CREATE TRIGGER soap_audit_logs_immutable
BEFORE UPDATE OR DELETE ON soap_audit_logs
FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();

COMMIT;
