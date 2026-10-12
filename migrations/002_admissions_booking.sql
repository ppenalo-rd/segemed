BEGIN;

ALTER TABLE patients
    ADD COLUMN IF NOT EXISTS document_type VARCHAR(20) NOT NULL DEFAULT 'cedula',
    ADD COLUMN IF NOT EXISTS guardian_name VARCHAR(160),
    ADD COLUMN IF NOT EXISTS guardian_document_type VARCHAR(20),
    ADD COLUMN IF NOT EXISTS guardian_document_number VARCHAR(40),
    ADD COLUMN IF NOT EXISTS guardian_relationship VARCHAR(60);

ALTER TABLE patients
    ALTER COLUMN dni_document DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'patients_document_type_check'
          AND conrelid = 'patients'::regclass
    ) THEN
        ALTER TABLE patients
            ADD CONSTRAINT patients_document_type_check
            CHECK (document_type IN ('cedula', 'passport', 'none'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'patients_document_required_check'
          AND conrelid = 'patients'::regclass
    ) THEN
        ALTER TABLE patients
            ADD CONSTRAINT patients_document_required_check
            CHECK (
                (document_type IN ('cedula', 'passport') AND dni_document IS NOT NULL AND btrim(dni_document) <> '')
                OR (document_type = 'none' AND dni_document IS NULL
                    AND guardian_name IS NOT NULL AND btrim(guardian_name) <> ''
                    AND guardian_document_type IN ('cedula', 'passport')
                    AND guardian_document_number IS NOT NULL AND btrim(guardian_document_number) <> '')
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'patients_guardian_relationship_required_check'
          AND conrelid = 'patients'::regclass
    ) THEN
        ALTER TABLE patients
            ADD CONSTRAINT patients_guardian_relationship_required_check
            CHECK (
                document_type <> 'none'
                OR (guardian_relationship IS NOT NULL AND btrim(guardian_relationship) <> '')
            );
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS doctor_user_accounts (
    doctor_id INTEGER PRIMARY KEY REFERENCES doctors(id),
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
    linked_by_user_id INTEGER REFERENCES users(id),
    linked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE doctors
    ADD COLUMN IF NOT EXISTS default_appointment_duration_minutes INTEGER NOT NULL DEFAULT 20;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'doctors_appointment_duration_check'
          AND conrelid = 'doctors'::regclass
    ) THEN
        ALTER TABLE doctors
            ADD CONSTRAINT doctors_appointment_duration_check
            CHECK (default_appointment_duration_minutes BETWEEN 5 AND 240);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS doctor_appointment_types (
    doctor_id INTEGER NOT NULL REFERENCES doctors(id),
    appointment_type VARCHAR(40) NOT NULL,
    duration_minutes INTEGER NOT NULL,
    PRIMARY KEY (doctor_id, appointment_type),
    CONSTRAINT doctor_appointment_type_duration_check
        CHECK (duration_minutes BETWEEN 5 AND 240)
);

ALTER TABLE appointments
    ADD COLUMN IF NOT EXISTS duration_minutes INTEGER NOT NULL DEFAULT 20,
    ADD COLUMN IF NOT EXISTS appointment_type VARCHAR(40) NOT NULL DEFAULT 'consultation',
    ADD COLUMN IF NOT EXISTS telehealth_url TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'appointments_duration_check'
          AND conrelid = 'appointments'::regclass
    ) THEN
        ALTER TABLE appointments
            ADD CONSTRAINT appointments_duration_check
            CHECK (duration_minutes BETWEEN 5 AND 240);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'appointments_type_check'
          AND conrelid = 'appointments'::regclass
    ) THEN
        ALTER TABLE appointments
            ADD CONSTRAINT appointments_type_check
            CHECK (appointment_type IN ('consultation', 'follow_up', 'minor_procedure'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS patients_document_lookup_idx
    ON patients (document_type, dni_document);
CREATE INDEX IF NOT EXISTS appointments_patient_slot_idx
    ON appointments (patient_id, appointment_date, time_scheduled)
    WHERE status <> 'Cancelled';
CREATE INDEX IF NOT EXISTS appointments_doctor_slot_idx
    ON appointments (doctor_id, appointment_date, time_scheduled)
    WHERE status <> 'Cancelled';

COMMIT;
