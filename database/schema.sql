BEGIN;

CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    role_key VARCHAR(60) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS permissions (
    id SERIAL PRIMARY KEY,
    permission_key VARCHAR(120) NOT NULL UNIQUE,
    module VARCHAR(60) NOT NULL,
    action VARCHAR(40) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id INTEGER NOT NULL REFERENCES roles(id),
    permission_id INTEGER NOT NULL REFERENCES permissions(id),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS user_roles (
    user_id INTEGER NOT NULL REFERENCES users(id),
    role_id INTEGER NOT NULL REFERENCES roles(id),
    assigned_by_user_id INTEGER REFERENCES users(id),
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, role_id)
);

INSERT INTO roles (role_key, name, description, is_system)
VALUES
    ('system_admin', 'Administrador del sistema', 'Administración y configuración de la plataforma.', TRUE),
    ('doctor', 'Médico', 'Atención clínica y documentación de consultas.', TRUE),
    ('admissions', 'Recepción / Admisiones', 'Gestión administrativa de pacientes, agenda y admisiones.', TRUE),
    ('audit_security', 'Auditoría / Seguridad', 'Auditoría, seguridad y asignación autorizada de roles.', TRUE),
    ('nurse', 'Enfermería', 'Admisión clínica, signos vitales y apoyo asistencial.', TRUE),
    ('patient', 'Paciente', 'Acceso del paciente a sus servicios habilitados.', TRUE)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO permissions (permission_key, module, action, description)
VALUES
    ('patients.read', 'patients', 'read', 'Consultar datos demográficos del paciente.'),
    ('patients.create', 'patients', 'create', 'Registrar pacientes.'),
    ('patients.update', 'patients', 'update', 'Actualizar datos demográficos del paciente.'),
    ('appointments.read', 'appointments', 'read', 'Consultar agenda y citas.'),
    ('appointments.manage', 'appointments', 'manage', 'Crear y administrar citas.'),
    ('clinical.read', 'clinical', 'read', 'Consultar información clínica autorizada.'),
    ('clinical.write', 'clinical', 'write', 'Crear y actualizar documentación clínica.'),
    ('clinical.sign', 'clinical', 'sign', 'Firmar documentación clínica.'),
    ('studies.manage', 'studies', 'manage', 'Crear órdenes y registrar resultados de estudios.'),
    ('prescriptions.manage', 'prescriptions', 'manage', 'Crear y administrar prescripciones.'),
    ('procedures.manage', 'procedures', 'manage', 'Registrar procedimientos ambulatorios.'),
    ('billing.manage', 'billing', 'manage', 'Administrar facturación y pagos.'),
    ('reports.read', 'reports', 'read', 'Consultar reportes autorizados.'),
    ('users.manage', 'security', 'manage', 'Administrar usuarios, roles y permisos.'),
    ('audit.read', 'audit', 'read', 'Consultar registros de auditoría.')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u
JOIN roles r ON r.role_key = CASE lower(btrim(u.role))
    WHEN 'admin' THEN 'system_admin'
    WHEN 'administrator' THEN 'system_admin'
    WHEN 'administrador' THEN 'system_admin'
    WHEN 'administrador del sistema' THEN 'system_admin'
    WHEN 'system_admin' THEN 'system_admin'
    WHEN 'doctor' THEN 'doctor'
    WHEN 'medico' THEN 'doctor'
    WHEN 'médico' THEN 'doctor'
    WHEN 'recepcion' THEN 'admissions'
    WHEN 'recepción' THEN 'admissions'
    WHEN 'reception' THEN 'admissions'
    WHEN 'admissions' THEN 'admissions'
    WHEN 'admisiones' THEN 'admissions'
    WHEN 'auditor' THEN 'audit_security'
    WHEN 'auditoria' THEN 'audit_security'
    WHEN 'auditoría' THEN 'audit_security'
    WHEN 'security' THEN 'audit_security'
    WHEN 'audit_security' THEN 'audit_security'
    WHEN 'nurse' THEN 'nurse'
    WHEN 'enfermeria' THEN 'nurse'
    WHEN 'enfermería' THEN 'nurse'
    WHEN 'patient' THEN 'patient'
    WHEN 'paciente' THEN 'patient'
    ELSE NULL
END
ON CONFLICT (user_id, role_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS specialties (
    id SERIAL PRIMARY KEY,
    code VARCHAR(40) UNIQUE,
    name VARCHAR(120) NOT NULL UNIQUE,
    description TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS doctor_specialties (
    doctor_id INTEGER NOT NULL REFERENCES doctors(id),
    specialty_id INTEGER NOT NULL REFERENCES specialties(id),
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (doctor_id, specialty_id)
);

INSERT INTO specialties (code, name, description)
VALUES
    ('medicina-general', 'Medicina General', 'Atención integral de salud y evaluación inicial.'),
    ('pediatria', 'Pediatría', 'Atención médica de niñas, niños y adolescentes.'),
    ('traumatologia', 'Traumatología', 'Evaluación y tratamiento del sistema musculoesquelético.'),
    ('cardiologia', 'Cardiología', 'Prevención, diagnóstico y tratamiento de enfermedades cardiovasculares.'),
    ('ginecologia', 'Ginecología', 'Atención de salud ginecológica y reproductiva.')
ON CONFLICT DO NOTHING;

WITH mapped_doctors AS (
    SELECT d.id AS doctor_id,
           CASE REGEXP_REPLACE(
               TRANSLATE(LOWER(BTRIM(d.main_specialty)), 'áéíóúüñ', 'aeiouun'),
               '[^a-z0-9]+',
               '',
               'g'
           )
               WHEN 'medicina' THEN 'medicina-general'
               WHEN 'medicinageneral' THEN 'medicina-general'
               WHEN 'medicinaintegral' THEN 'medicina-general'
               WHEN 'pediatria' THEN 'pediatria'
               WHEN 'traumatologia' THEN 'traumatologia'
               WHEN 'traumatologiayortopedia' THEN 'traumatologia'
               WHEN 'ortopedia' THEN 'traumatologia'
               WHEN 'cardiologia' THEN 'cardiologia'
               WHEN 'ginecologia' THEN 'ginecologia'
               WHEN 'ginecologiayobstetricia' THEN 'ginecologia'
               WHEN 'obstetriciayginecologia' THEN 'ginecologia'
               ELSE NULL
           END AS specialty_code
    FROM doctors d
    WHERE NULLIF(BTRIM(d.main_specialty), '') IS NOT NULL
)
INSERT INTO doctor_specialties (doctor_id, specialty_id, is_primary)
SELECT md.doctor_id, s.id, TRUE
FROM mapped_doctors md
JOIN specialties s ON s.code = md.specialty_code AND s.active = TRUE
WHERE md.specialty_code IS NOT NULL
ON CONFLICT (doctor_id, specialty_id)
DO UPDATE SET is_primary = TRUE;

ALTER TABLE appointments
    ADD COLUMN IF NOT EXISTS care_mode VARCHAR(20) NOT NULL DEFAULT 'in_person';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'appointments_care_mode_check'
          AND conrelid = 'appointments'::regclass
    ) THEN
        ALTER TABLE appointments
            ADD CONSTRAINT appointments_care_mode_check
            CHECK (care_mode IN ('in_person', 'teleconsultation'));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS consultation_diagnoses (
    id SERIAL PRIMARY KEY,
    consultation_id INTEGER NOT NULL REFERENCES medical_consultations(id),
    cie_id INTEGER NOT NULL REFERENCES cie_catalog(id),
    diagnosis_type VARCHAR(20) NOT NULL,
    notes TEXT,
    recorded_by_user_id INTEGER REFERENCES users(id),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT consultation_diagnoses_type_check
        CHECK (diagnosis_type IN ('primary', 'secondary', 'tertiary')),
    CONSTRAINT consultation_diagnoses_unique UNIQUE (consultation_id, cie_id)
);

CREATE TABLE IF NOT EXISTS study_catalog (
    id SERIAL PRIMARY KEY,
    code VARCHAR(60) UNIQUE,
    name VARCHAR(160) NOT NULL UNIQUE,
    category VARCHAR(80) NOT NULL,
    description TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS study_orders (
    id SERIAL PRIMARY KEY,
    consultation_id INTEGER NOT NULL REFERENCES medical_consultations(id),
    study_id INTEGER NOT NULL REFERENCES study_catalog(id),
    ordered_by_user_id INTEGER NOT NULL REFERENCES users(id),
    priority VARCHAR(20) NOT NULL DEFAULT 'routine',
    status VARCHAR(20) NOT NULL DEFAULT 'ordered',
    ordered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    scheduled_at TIMESTAMPTZ,
    instructions TEXT,
    CONSTRAINT study_orders_priority_check
        CHECK (priority IN ('routine', 'urgent', 'stat')),
    CONSTRAINT study_orders_status_check
        CHECK (status IN ('ordered', 'scheduled', 'in_progress', 'completed', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS study_results (
    id SERIAL PRIMARY KEY,
    study_order_id INTEGER NOT NULL REFERENCES study_orders(id),
    result_text TEXT NOT NULL,
    result_value NUMERIC(14, 4),
    result_unit VARCHAR(40),
    reference_range VARCHAR(120),
    status VARCHAR(20) NOT NULL DEFAULT 'preliminary',
    resulted_by_user_id INTEGER REFERENCES users(id),
    resulted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    attachment_id INTEGER REFERENCES patient_attachments(id),
    CONSTRAINT study_results_status_check
        CHECK (status IN ('preliminary', 'final', 'amended'))
);

CREATE TABLE IF NOT EXISTS medications (
    id SERIAL PRIMARY KEY,
    code VARCHAR(80) UNIQUE,
    name VARCHAR(180) NOT NULL,
    active_ingredient VARCHAR(180),
    strength VARCHAR(100),
    dosage_form VARCHAR(100),
    route VARCHAR(80),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT medications_name_strength_form_unique
        UNIQUE (name, strength, dosage_form)
);

CREATE TABLE IF NOT EXISTS prescriptions (
    id SERIAL PRIMARY KEY,
    consultation_id INTEGER NOT NULL REFERENCES medical_consultations(id),
    prescribed_by_user_id INTEGER NOT NULL REFERENCES users(id),
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    instructions TEXT,
    signed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT prescriptions_status_check
        CHECK (status IN ('draft', 'active', 'cancelled', 'completed'))
);

CREATE TABLE IF NOT EXISTS prescription_items (
    id SERIAL PRIMARY KEY,
    prescription_id INTEGER NOT NULL REFERENCES prescriptions(id),
    medication_id INTEGER REFERENCES medications(id),
    medication_name VARCHAR(180) NOT NULL,
    strength VARCHAR(100),
    dose VARCHAR(100) NOT NULL,
    route VARCHAR(80),
    frequency VARCHAR(120) NOT NULL,
    duration VARCHAR(100),
    quantity NUMERIC(10, 2),
    instructions TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS consents (
    id SERIAL PRIMARY KEY,
    patient_id INTEGER NOT NULL REFERENCES patients(id),
    consultation_id INTEGER REFERENCES medical_consultations(id),
    consent_type VARCHAR(80) NOT NULL,
    document_version VARCHAR(40),
    content TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    signed_by_user_id INTEGER REFERENCES users(id),
    signed_at TIMESTAMPTZ,
    signature_reference TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT consents_status_check
        CHECK (status IN ('pending', 'signed', 'declined', 'revoked'))
);

CREATE TABLE IF NOT EXISTS minor_procedures (
    id SERIAL PRIMARY KEY,
    consultation_id INTEGER NOT NULL REFERENCES medical_consultations(id),
    procedure_code VARCHAR(60),
    name VARCHAR(180) NOT NULL,
    description TEXT,
    performed_by_user_id INTEGER NOT NULL REFERENCES users(id),
    consent_id INTEGER REFERENCES consents(id),
    performed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) NOT NULL DEFAULT 'completed',
    outcome TEXT,
    follow_up_instructions TEXT,
    CONSTRAINT minor_procedures_status_check
        CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS nursing_records (
    id SERIAL PRIMARY KEY,
    consultation_id INTEGER NOT NULL REFERENCES medical_consultations(id),
    recorded_by_user_id INTEGER NOT NULL REFERENCES users(id),
    note TEXT,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vital_signs (
    id SERIAL PRIMARY KEY,
    nursing_record_id INTEGER REFERENCES nursing_records(id),
    consultation_id INTEGER NOT NULL REFERENCES medical_consultations(id),
    recorded_by_user_id INTEGER REFERENCES users(id),
    blood_pressure VARCHAR(20),
    heart_rate SMALLINT,
    respiratory_rate SMALLINT,
    temperature_c NUMERIC(4, 1),
    oxygen_saturation SMALLINT,
    weight_kg NUMERIC(6, 2),
    height_cm NUMERIC(6, 2),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT vital_signs_heart_rate_check CHECK (heart_rate IS NULL OR heart_rate > 0),
    CONSTRAINT vital_signs_respiratory_rate_check CHECK (respiratory_rate IS NULL OR respiratory_rate > 0),
    CONSTRAINT vital_signs_temperature_check CHECK (temperature_c IS NULL OR temperature_c BETWEEN 25 AND 45),
    CONSTRAINT vital_signs_oxygen_saturation_check CHECK (oxygen_saturation IS NULL OR oxygen_saturation BETWEEN 0 AND 100),
    CONSTRAINT vital_signs_weight_check CHECK (weight_kg IS NULL OR weight_kg > 0),
    CONSTRAINT vital_signs_height_check CHECK (height_cm IS NULL OR height_cm > 0)
);

CREATE TABLE IF NOT EXISTS billing_currencies (
    code CHAR(3) PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by_user_id INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT billing_currencies_code_check CHECK (code ~ '^[A-Z]{3}$')
);

INSERT INTO billing_currencies (code, name)
VALUES ('USD', 'Dólar estadounidense')
ON CONFLICT (code) DO NOTHING;

INSERT INTO billing_currencies (code, name)
VALUES ('VES', 'Bolívar venezolano')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS billing_settings (
    id SMALLINT PRIMARY KEY DEFAULT 1,
    base_currency CHAR(3) NOT NULL REFERENCES billing_currencies(code),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT billing_settings_singleton_check CHECK (id = 1)
);

INSERT INTO billing_settings (id, base_currency)
VALUES (1, 'VES')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS billing_exchange_rates (
    id BIGSERIAL PRIMARY KEY,
    currency_code CHAR(3) NOT NULL REFERENCES billing_currencies(code),
    rate_to_usd NUMERIC(18, 8) NOT NULL,
    units_per_usd NUMERIC(18, 8) NOT NULL,
    effective_at TIMESTAMPTZ NOT NULL,
    source VARCHAR(160) NOT NULL,
    created_by_user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT billing_exchange_rates_positive_check CHECK (rate_to_usd > 0),
    CONSTRAINT billing_exchange_rates_units_per_usd_check CHECK (units_per_usd > 0),
    CONSTRAINT billing_exchange_rates_source_check CHECK (btrim(source) <> ''),
    CONSTRAINT billing_exchange_rates_effective_unique UNIQUE (currency_code, effective_at)
);

CREATE INDEX IF NOT EXISTS billing_exchange_rates_current_idx
    ON billing_exchange_rates (currency_code, effective_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS billing_services (
    id SERIAL PRIMARY KEY,
    code VARCHAR(60) UNIQUE,
    name VARCHAR(180) NOT NULL,
    service_type VARCHAR(20) NOT NULL,
    description TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by_user_id INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT billing_services_type_check
        CHECK (service_type IN ('consultation', 'procedure', 'study'))
);

CREATE TABLE IF NOT EXISTS billing_service_prices (
    id SERIAL PRIMARY KEY,
    service_id INTEGER NOT NULL REFERENCES billing_services(id),
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    price_usd NUMERIC(12, 2) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by_user_id INTEGER REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT billing_service_prices_nonnegative_check CHECK (price_usd >= 0),
    CONSTRAINT billing_service_prices_service_branch_unique UNIQUE (service_id, branch_id)
);

CREATE TABLE IF NOT EXISTS invoices (
    id SERIAL PRIMARY KEY,
    invoice_number VARCHAR(60) UNIQUE,
    patient_id INTEGER NOT NULL REFERENCES patients(id),
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    consultation_id INTEGER REFERENCES medical_consultations(id),
    issued_by_user_id INTEGER REFERENCES users(id),
    issued_at TIMESTAMPTZ,
    created_by_user_id INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    currency CHAR(3) NOT NULL REFERENCES billing_currencies(code),
    exchange_rate_to_usd NUMERIC(18, 8),
    exchange_rate_units_per_usd NUMERIC(18, 8),
    subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
    discount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    tax NUMERIC(12, 2) NOT NULL DEFAULT 0,
    total NUMERIC(12, 2) NOT NULL DEFAULT 0,
    total_usd NUMERIC(12, 2),
    status VARCHAR(20) NOT NULL DEFAULT 'draft',
    notes TEXT,
    CONSTRAINT invoices_amounts_check
        CHECK (subtotal >= 0 AND discount >= 0 AND tax >= 0 AND total >= 0),
    CONSTRAINT invoices_exchange_rate_check
        CHECK (exchange_rate_to_usd IS NULL OR exchange_rate_to_usd > 0),
    CONSTRAINT invoices_exchange_rate_units_per_usd_check
        CHECK (exchange_rate_units_per_usd IS NULL OR exchange_rate_units_per_usd > 0),
    CONSTRAINT invoices_total_usd_check
        CHECK (total_usd IS NULL OR total_usd >= 0),
    CONSTRAINT invoices_status_check
        CHECK (status IN ('draft', 'pending', 'paid', 'void'))
);

CREATE TABLE IF NOT EXISTS invoice_items (
    id SERIAL PRIMARY KEY,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id),
    service_id INTEGER REFERENCES billing_services(id),
    description VARCHAR(240) NOT NULL,
    category VARCHAR(60) NOT NULL,
    quantity NUMERIC(10, 2) NOT NULL DEFAULT 1,
    unit_price NUMERIC(12, 2) NOT NULL,
    line_total NUMERIC(12, 2) NOT NULL,
    base_unit_price_usd NUMERIC(12, 2),
    consultation_id INTEGER REFERENCES medical_consultations(id),
    procedure_id INTEGER REFERENCES minor_procedures(id),
    study_order_id INTEGER REFERENCES study_orders(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT invoice_items_amounts_check
        CHECK (quantity > 0 AND unit_price >= 0 AND line_total >= 0)
);

CREATE TABLE IF NOT EXISTS billing_transactions (
    id BIGSERIAL PRIMARY KEY,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id),
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    transaction_type VARCHAR(12) NOT NULL,
    reversal_of_transaction_id BIGINT UNIQUE REFERENCES billing_transactions(id),
    amount NUMERIC(12, 2) NOT NULL,
    currency CHAR(3) NOT NULL REFERENCES billing_currencies(code),
    exchange_rate_to_usd NUMERIC(18, 8) NOT NULL,
    exchange_rate_units_per_usd NUMERIC(18, 8) NOT NULL,
    amount_usd NUMERIC(12, 2) NOT NULL,
    reference VARCHAR(160),
    received_by_user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT billing_transactions_type_check CHECK (transaction_type IN ('payment', 'refund')),
    CONSTRAINT billing_transactions_amount_check CHECK (amount > 0 AND amount_usd > 0),
    CONSTRAINT billing_transactions_rate_check CHECK (exchange_rate_to_usd > 0),
    CONSTRAINT billing_transactions_units_per_usd_check CHECK (exchange_rate_units_per_usd > 0),
    CONSTRAINT billing_transactions_reversal_shape_check CHECK (
        (transaction_type = 'payment' AND reversal_of_transaction_id IS NULL)
        OR (transaction_type = 'refund' AND reversal_of_transaction_id IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS billing_audit_events (
    id BIGSERIAL PRIMARY KEY,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id),
    event_type VARCHAR(24) NOT NULL,
    actor_user_id INTEGER NOT NULL REFERENCES users(id),
    details JSONB NOT NULL DEFAULT '{}'::JSONB,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT billing_audit_event_type_check
        CHECK (event_type IN ('draft_created', 'item_added', 'issued', 'payment', 'refund', 'void'))
);

CREATE TABLE IF NOT EXISTS access_audit_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    patient_id INTEGER REFERENCES patients(id),
    event_type VARCHAR(60) NOT NULL,
    resource_type VARCHAR(80) NOT NULL,
    resource_id VARCHAR(100),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ip_address INET,
    user_agent TEXT,
    details JSONB NOT NULL DEFAULT '{}'::JSONB
);

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

CREATE INDEX IF NOT EXISTS appointments_patient_date_idx
    ON appointments (patient_id, appointment_date);
CREATE INDEX IF NOT EXISTS appointments_doctor_date_idx
    ON appointments (doctor_id, appointment_date);
ALTER TABLE medical_consultations
    ADD COLUMN IF NOT EXISTS soap_last_saved_at TIMESTAMPTZ;
UPDATE medical_consultations
SET soap_last_saved_at = created_at
WHERE soap_last_saved_at IS NULL;
ALTER TABLE medical_consultations
    ALTER COLUMN soap_last_saved_at SET DEFAULT CURRENT_TIMESTAMP,
    ALTER COLUMN soap_last_saved_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS consultations_patient_created_idx
    ON medical_consultations (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS consultation_diagnoses_consultation_idx
    ON consultation_diagnoses (consultation_id);
CREATE INDEX IF NOT EXISTS study_orders_consultation_status_idx
    ON study_orders (consultation_id, status);
CREATE INDEX IF NOT EXISTS study_results_order_resulted_idx
    ON study_results (study_order_id, resulted_at DESC);
CREATE INDEX IF NOT EXISTS prescriptions_consultation_created_idx
    ON prescriptions (consultation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS procedures_consultation_performed_idx
    ON minor_procedures (consultation_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS invoices_patient_issued_idx
    ON invoices (patient_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS access_audit_patient_occurred_idx
    ON access_audit_logs (patient_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS access_audit_user_occurred_idx
    ON access_audit_logs (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS appointments_reporting_date_branch_idx
    ON appointments (appointment_date, branch_id)
    INCLUDE (status, doctor_id, duration_minutes);
CREATE INDEX IF NOT EXISTS consultations_reporting_appointment_idx
    ON medical_consultations (appointment_id, created_at);
CREATE INDEX IF NOT EXISTS study_orders_reporting_ordered_idx
    ON study_orders (ordered_at, consultation_id)
    INCLUDE (status);
CREATE INDEX IF NOT EXISTS procedures_reporting_performed_idx
    ON minor_procedures (performed_at, consultation_id)
    INCLUDE (status);
CREATE INDEX IF NOT EXISTS invoices_reporting_issued_idx
    ON invoices (issued_at, branch_id)
    INCLUDE (status, total_usd)
    WHERE issued_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS billing_transactions_reporting_created_idx
    ON billing_transactions (created_at, branch_id)
    INCLUDE (transaction_type, amount_usd);

CREATE OR REPLACE FUNCTION reject_audit_log_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Audit records are immutable';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_immutable ON audit_logs;
CREATE TRIGGER audit_logs_immutable
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();

DROP TRIGGER IF EXISTS access_audit_logs_immutable ON access_audit_logs;
CREATE TRIGGER access_audit_logs_immutable
BEFORE UPDATE OR DELETE ON access_audit_logs
FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();

CREATE TABLE IF NOT EXISTS reporting_refresh_log (
    id BIGSERIAL PRIMARY KEY,
    refreshed_by_user_id INTEGER REFERENCES users(id),
    refreshed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    views_refreshed INTEGER NOT NULL,
    CONSTRAINT reporting_refresh_log_views_check CHECK (views_refreshed > 0)
);

CREATE OR REPLACE FUNCTION reject_reporting_refresh_log_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Reporting refresh audit records are immutable';
END;
$$;

DROP TRIGGER IF EXISTS reporting_refresh_log_immutable ON reporting_refresh_log;
CREATE TRIGGER reporting_refresh_log_immutable
BEFORE UPDATE OR DELETE ON reporting_refresh_log
FOR EACH ROW EXECUTE FUNCTION reject_reporting_refresh_log_mutation();

CREATE MATERIALIZED VIEW IF NOT EXISTS reporting_clinical_daily_mv AS
WITH appointment_totals AS (
    SELECT appointment_date AS report_date, branch_id,
           COUNT(*)::BIGINT AS appointments,
           COUNT(*) FILTER (WHERE status <> 'Cancelled')::BIGINT AS booked_appointments,
           COUNT(*) FILTER (WHERE status = 'Attended')::BIGINT AS attended_appointments,
           COUNT(*) FILTER (WHERE status = 'Cancelled')::BIGINT AS cancelled_appointments
    FROM appointments
    GROUP BY appointment_date, branch_id
),
consultation_totals AS (
    SELECT a.appointment_date AS report_date, a.branch_id,
           COUNT(DISTINCT mc.id)::BIGINT AS consultations
    FROM medical_consultations mc
    JOIN appointments a ON a.id = mc.appointment_id
    GROUP BY a.appointment_date, a.branch_id
),
study_totals AS (
    SELECT so.ordered_at::date AS report_date, a.branch_id,
           COUNT(*)::BIGINT AS study_orders
    FROM study_orders so
    JOIN medical_consultations mc ON mc.id = so.consultation_id
    JOIN appointments a ON a.id = mc.appointment_id
    GROUP BY so.ordered_at::date, a.branch_id
),
procedure_totals AS (
    SELECT mp.performed_at::date AS report_date, a.branch_id,
           COUNT(*)::BIGINT AS procedures
    FROM minor_procedures mp
    JOIN medical_consultations mc ON mc.id = mp.consultation_id
    JOIN appointments a ON a.id = mc.appointment_id
    GROUP BY mp.performed_at::date, a.branch_id
),
report_keys AS (
    SELECT report_date, branch_id FROM appointment_totals
    UNION SELECT report_date, branch_id FROM consultation_totals
    UNION SELECT report_date, branch_id FROM study_totals
    UNION SELECT report_date, branch_id FROM procedure_totals
)
SELECT k.report_date, k.branch_id,
       COALESCE(a.appointments, 0)::BIGINT AS appointments,
       COALESCE(a.booked_appointments, 0)::BIGINT AS booked_appointments,
       COALESCE(a.attended_appointments, 0)::BIGINT AS attended_appointments,
       COALESCE(a.cancelled_appointments, 0)::BIGINT AS cancelled_appointments,
       COALESCE(c.consultations, 0)::BIGINT AS consultations,
       COALESCE(s.study_orders, 0)::BIGINT AS study_orders,
       COALESCE(p.procedures, 0)::BIGINT AS procedures
FROM report_keys k
LEFT JOIN appointment_totals a USING (report_date, branch_id)
LEFT JOIN consultation_totals c USING (report_date, branch_id)
LEFT JOIN study_totals s USING (report_date, branch_id)
LEFT JOIN procedure_totals p USING (report_date, branch_id)
WITH DATA;
CREATE UNIQUE INDEX IF NOT EXISTS reporting_clinical_daily_mv_pk
    ON reporting_clinical_daily_mv (report_date, branch_id);
CREATE INDEX IF NOT EXISTS reporting_clinical_daily_mv_branch_date_idx
    ON reporting_clinical_daily_mv (branch_id, report_date);

CREATE MATERIALIZED VIEW IF NOT EXISTS reporting_specialty_daily_mv AS
SELECT a.appointment_date AS report_date, a.branch_id,
       COALESCE(specialty.name, NULLIF(BTRIM(d.main_specialty), ''), 'Sin especialidad') AS specialty,
       COUNT(DISTINCT mc.id)::BIGINT AS consultations
FROM medical_consultations mc
JOIN appointments a ON a.id = mc.appointment_id
LEFT JOIN doctor_user_accounts dua ON dua.user_id = a.doctor_id
LEFT JOIN doctors d ON d.id = dua.doctor_id
LEFT JOIN LATERAL (
    SELECT s.name
    FROM doctor_specialties ds
    JOIN specialties s ON s.id = ds.specialty_id
    WHERE ds.doctor_id = d.id AND s.active IS DISTINCT FROM FALSE
    ORDER BY ds.is_primary DESC, s.name
    LIMIT 1
) specialty ON TRUE
GROUP BY a.appointment_date, a.branch_id,
         COALESCE(specialty.name, NULLIF(BTRIM(d.main_specialty), ''), 'Sin especialidad')
WITH DATA;
CREATE UNIQUE INDEX IF NOT EXISTS reporting_specialty_daily_mv_pk
    ON reporting_specialty_daily_mv (report_date, branch_id, specialty);
CREATE INDEX IF NOT EXISTS reporting_specialty_daily_mv_branch_date_idx
    ON reporting_specialty_daily_mv (branch_id, report_date);

CREATE MATERIALIZED VIEW IF NOT EXISTS reporting_financial_daily_mv AS
WITH invoice_totals AS (
    SELECT issued_at::date AS report_date, branch_id,
           COUNT(*) FILTER (WHERE status <> 'void')::BIGINT AS invoices_issued,
           COUNT(*) FILTER (WHERE status = 'paid')::BIGINT AS invoices_paid,
           COUNT(*) FILTER (WHERE status = 'void')::BIGINT AS invoices_voided,
           COALESCE(SUM(total_usd) FILTER (WHERE status IN ('pending', 'paid')), 0)::NUMERIC(14, 2) AS invoiced_usd,
           COALESCE(SUM(total_usd) FILTER (WHERE status = 'void'), 0)::NUMERIC(14, 2) AS voided_usd
    FROM invoices
    WHERE issued_at IS NOT NULL
    GROUP BY issued_at::date, branch_id
),
transaction_totals AS (
    SELECT created_at::date AS report_date, branch_id,
           COALESCE(SUM(amount_usd) FILTER (WHERE transaction_type = 'payment'), 0)::NUMERIC(14, 2) AS payments_usd,
           COALESCE(SUM(amount_usd) FILTER (WHERE transaction_type = 'refund'), 0)::NUMERIC(14, 2) AS refunds_usd
    FROM billing_transactions
    GROUP BY created_at::date, branch_id
),
report_keys AS (
    SELECT report_date, branch_id FROM invoice_totals
    UNION SELECT report_date, branch_id FROM transaction_totals
)
SELECT k.report_date, k.branch_id,
       COALESCE(i.invoices_issued, 0)::BIGINT AS invoices_issued,
       COALESCE(i.invoices_paid, 0)::BIGINT AS invoices_paid,
       COALESCE(i.invoices_voided, 0)::BIGINT AS invoices_voided,
       COALESCE(i.invoiced_usd, 0)::NUMERIC(14, 2) AS invoiced_usd,
       COALESCE(i.voided_usd, 0)::NUMERIC(14, 2) AS voided_usd,
       COALESCE(t.payments_usd, 0)::NUMERIC(14, 2) AS payments_usd,
       COALESCE(t.refunds_usd, 0)::NUMERIC(14, 2) AS refunds_usd,
       (COALESCE(t.payments_usd, 0) - COALESCE(t.refunds_usd, 0))::NUMERIC(14, 2) AS collected_net_usd
FROM report_keys k
LEFT JOIN invoice_totals i USING (report_date, branch_id)
LEFT JOIN transaction_totals t USING (report_date, branch_id)
WITH DATA;
CREATE UNIQUE INDEX IF NOT EXISTS reporting_financial_daily_mv_pk
    ON reporting_financial_daily_mv (report_date, branch_id);
CREATE INDEX IF NOT EXISTS reporting_financial_daily_mv_branch_date_idx
    ON reporting_financial_daily_mv (branch_id, report_date);

INSERT INTO reporting_refresh_log (views_refreshed)
SELECT 3
WHERE NOT EXISTS (SELECT 1 FROM reporting_refresh_log);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.role_key IN ('system_admin', 'audit_security', 'admissions', 'doctor', 'nurse')
  AND p.permission_key = 'reports.read'
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;
