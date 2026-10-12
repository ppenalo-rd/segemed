BEGIN;

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
    SELECT appointment_date AS report_date,
           branch_id,
           COUNT(*)::BIGINT AS appointments,
           COUNT(*) FILTER (WHERE status <> 'Cancelled')::BIGINT AS booked_appointments,
           COUNT(*) FILTER (WHERE status = 'Attended')::BIGINT AS attended_appointments,
           COUNT(*) FILTER (WHERE status = 'Cancelled')::BIGINT AS cancelled_appointments
    FROM appointments
    GROUP BY appointment_date, branch_id
),
consultation_totals AS (
    SELECT a.appointment_date AS report_date,
           a.branch_id,
           COUNT(DISTINCT mc.id)::BIGINT AS consultations
    FROM medical_consultations mc
    JOIN appointments a ON a.id = mc.appointment_id
    GROUP BY a.appointment_date, a.branch_id
),
study_totals AS (
    SELECT so.ordered_at::date AS report_date,
           a.branch_id,
           COUNT(*)::BIGINT AS study_orders
    FROM study_orders so
    JOIN medical_consultations mc ON mc.id = so.consultation_id
    JOIN appointments a ON a.id = mc.appointment_id
    GROUP BY so.ordered_at::date, a.branch_id
),
procedure_totals AS (
    SELECT mp.performed_at::date AS report_date,
           a.branch_id,
           COUNT(*)::BIGINT AS procedures
    FROM minor_procedures mp
    JOIN medical_consultations mc ON mc.id = mp.consultation_id
    JOIN appointments a ON a.id = mc.appointment_id
    GROUP BY mp.performed_at::date, a.branch_id
),
report_keys AS (
    SELECT report_date, branch_id FROM appointment_totals
    UNION
    SELECT report_date, branch_id FROM consultation_totals
    UNION
    SELECT report_date, branch_id FROM study_totals
    UNION
    SELECT report_date, branch_id FROM procedure_totals
)
SELECT k.report_date,
       k.branch_id,
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
SELECT COALESCE(a.appointment_date, mc.created_at::date) AS report_date,
       a.branch_id,
       COALESCE(
           specialty.name,
           NULLIF(BTRIM(d.main_specialty), ''),
           'Sin especialidad'
       ) AS specialty,
       COUNT(DISTINCT mc.id)::BIGINT AS consultations
FROM medical_consultations mc
JOIN appointments a ON a.id = mc.appointment_id
LEFT JOIN doctor_user_accounts dua ON dua.user_id = a.doctor_id
LEFT JOIN doctors d ON d.id = dua.doctor_id
LEFT JOIN LATERAL (
    SELECT s.name
    FROM doctor_specialties ds
    JOIN specialties s ON s.id = ds.specialty_id
    WHERE ds.doctor_id = d.id
      AND s.active IS DISTINCT FROM FALSE
    ORDER BY ds.is_primary DESC, s.name
    LIMIT 1
) specialty ON TRUE
GROUP BY COALESCE(a.appointment_date, mc.created_at::date),
         a.branch_id,
         COALESCE(specialty.name, NULLIF(BTRIM(d.main_specialty), ''), 'Sin especialidad')
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS reporting_specialty_daily_mv_pk
    ON reporting_specialty_daily_mv (report_date, branch_id, specialty);
CREATE INDEX IF NOT EXISTS reporting_specialty_daily_mv_branch_date_idx
    ON reporting_specialty_daily_mv (branch_id, report_date);

CREATE MATERIALIZED VIEW IF NOT EXISTS reporting_financial_daily_mv AS
WITH invoice_totals AS (
    SELECT issued_at::date AS report_date,
           branch_id,
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
    SELECT created_at::date AS report_date,
           branch_id,
           COALESCE(SUM(amount_usd) FILTER (WHERE transaction_type = 'payment'), 0)::NUMERIC(14, 2) AS payments_usd,
           COALESCE(SUM(amount_usd) FILTER (WHERE transaction_type = 'refund'), 0)::NUMERIC(14, 2) AS refunds_usd
    FROM billing_transactions
    GROUP BY created_at::date, branch_id
),
report_keys AS (
    SELECT report_date, branch_id FROM invoice_totals
    UNION
    SELECT report_date, branch_id FROM transaction_totals
)
SELECT k.report_date,
       k.branch_id,
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
