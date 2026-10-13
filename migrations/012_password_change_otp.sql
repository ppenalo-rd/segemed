BEGIN;

CREATE TABLE IF NOT EXISTS password_change_challenges (
    challenge_id UUID PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    requested_by_user_id INTEGER NOT NULL REFERENCES users(id),
    otp_hash VARCHAR(64) NOT NULL,
    new_password_hash VARCHAR(100) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    attempts SMALLINT NOT NULL DEFAULT 0,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resend_after TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT password_change_attempts_check CHECK (attempts BETWEEN 0 AND 5)
);

CREATE INDEX IF NOT EXISTS password_change_challenges_expiry_idx
    ON password_change_challenges (expires_at);

COMMIT;
