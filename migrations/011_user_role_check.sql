BEGIN;

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
    ADD CONSTRAINT users_role_check
    CHECK (role IN (
        'admin',
        'doctor',
        'receptionist',
        'system_admin',
        'admissions',
        'audit_security',
        'nurse',
        'patient'
    ));

COMMIT;
