BEGIN;

CREATE TABLE IF NOT EXISTS email_otp_challenges (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    otp_hash VARCHAR(64) NOT NULL,
    otp_expires_at TIMESTAMPTZ NOT NULL,
    attempts SMALLINT NOT NULL DEFAULT 0,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resend_after TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT email_otp_attempts_check CHECK (attempts BETWEEN 0 AND 5)
);

CREATE INDEX IF NOT EXISTS email_otp_challenges_expiry_idx
    ON email_otp_challenges (otp_expires_at);

COMMIT;
