BEGIN;

CREATE TABLE IF NOT EXISTS billing_currencies (
    code CHAR(3) PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by_user_id INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT billing_currencies_code_check CHECK (code ~ '^[A-Z]{3}$')
);

INSERT INTO billing_currencies (code, name, active)
VALUES ('USD', 'Dólar estadounidense', TRUE)
ON CONFLICT (code) DO NOTHING;

INSERT INTO billing_currencies (code, name, active)
SELECT DISTINCT upper(currency), upper(currency), TRUE
FROM invoices
WHERE currency ~ '^[A-Za-z]{3}$'
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS billing_exchange_rates (
    id BIGSERIAL PRIMARY KEY,
    currency_code CHAR(3) NOT NULL REFERENCES billing_currencies(code),
    rate_to_usd NUMERIC(18, 8) NOT NULL,
    effective_at TIMESTAMPTZ NOT NULL,
    source VARCHAR(160) NOT NULL,
    created_by_user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT billing_exchange_rates_positive_check CHECK (rate_to_usd > 0),
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

ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id),
    ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS exchange_rate_to_usd NUMERIC(18, 8),
    ADD COLUMN IF NOT EXISTS total_usd NUMERIC(12, 2);

UPDATE invoices i
SET branch_id = COALESCE(
    (SELECT a.branch_id
     FROM medical_consultations mc
     JOIN appointments a ON a.id = mc.appointment_id
     WHERE mc.id = i.consultation_id),
    (SELECT b.id FROM branches b WHERE b.active IS DISTINCT FROM FALSE ORDER BY b.id LIMIT 1)
)
WHERE i.branch_id IS NULL;

UPDATE invoices
SET created_by_user_id = issued_by_user_id,
    created_at = COALESCE(issued_at, CURRENT_TIMESTAMP),
    exchange_rate_to_usd = CASE WHEN currency = 'USD' THEN 1 ELSE exchange_rate_to_usd END,
    total_usd = CASE WHEN currency = 'USD' THEN total ELSE total_usd END,
    status = CASE status
        WHEN 'issued' THEN 'pending'
        WHEN 'partially_paid' THEN 'pending'
        ELSE status
    END;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM invoices WHERE branch_id IS NULL) THEN
        RAISE EXCEPTION 'No se puede completar billing: las facturas existentes necesitan una sede asignada.';
    END IF;
END $$;

ALTER TABLE invoices
    ALTER COLUMN branch_id SET NOT NULL,
    ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP,
    ALTER COLUMN created_at SET NOT NULL,
    ALTER COLUMN invoice_number DROP NOT NULL,
    ALTER COLUMN issued_at DROP NOT NULL,
    ALTER COLUMN issued_at DROP DEFAULT;

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE invoices
    ADD CONSTRAINT invoices_status_check CHECK (status IN ('draft', 'pending', 'paid', 'void'));

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_exchange_rate_check'
                   AND conrelid = 'invoices'::regclass) THEN
        ALTER TABLE invoices ADD CONSTRAINT invoices_exchange_rate_check
            CHECK (exchange_rate_to_usd IS NULL OR exchange_rate_to_usd > 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_total_usd_check'
                   AND conrelid = 'invoices'::regclass) THEN
        ALTER TABLE invoices ADD CONSTRAINT invoices_total_usd_check
            CHECK (total_usd IS NULL OR total_usd >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_currency_fk'
                   AND conrelid = 'invoices'::regclass) THEN
        ALTER TABLE invoices ADD CONSTRAINT invoices_currency_fk
            FOREIGN KEY (currency) REFERENCES billing_currencies(code);
    END IF;
END $$;

ALTER TABLE invoice_items
    ADD COLUMN IF NOT EXISTS service_id INTEGER REFERENCES billing_services(id),
    ADD COLUMN IF NOT EXISTS base_unit_price_usd NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS consultation_id INTEGER REFERENCES medical_consultations(id),
    ADD COLUMN IF NOT EXISTS study_order_id INTEGER REFERENCES study_orders(id);

CREATE TABLE IF NOT EXISTS billing_transactions (
    id BIGSERIAL PRIMARY KEY,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id),
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    transaction_type VARCHAR(12) NOT NULL,
    reversal_of_transaction_id BIGINT UNIQUE REFERENCES billing_transactions(id),
    amount NUMERIC(12, 2) NOT NULL,
    currency CHAR(3) NOT NULL REFERENCES billing_currencies(code),
    exchange_rate_to_usd NUMERIC(18, 8) NOT NULL,
    amount_usd NUMERIC(12, 2) NOT NULL,
    reference VARCHAR(160),
    received_by_user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT billing_transactions_type_check CHECK (transaction_type IN ('payment', 'refund')),
    CONSTRAINT billing_transactions_amount_check CHECK (amount > 0 AND amount_usd > 0),
    CONSTRAINT billing_transactions_rate_check CHECK (exchange_rate_to_usd > 0),
    CONSTRAINT billing_transactions_reversal_shape_check CHECK (
        (transaction_type = 'payment' AND reversal_of_transaction_id IS NULL)
        OR (transaction_type = 'refund' AND reversal_of_transaction_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS billing_transactions_invoice_created_idx
    ON billing_transactions (invoice_id, created_at, id);

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

CREATE INDEX IF NOT EXISTS billing_audit_events_invoice_idx
    ON billing_audit_events (invoice_id, occurred_at DESC, id DESC);

CREATE OR REPLACE FUNCTION reject_billing_record_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Billing ledger records are immutable';
END;
$$;

CREATE OR REPLACE FUNCTION protect_billing_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    action_name TEXT := current_setting('sigemed.billing_action', TRUE);
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Invoices cannot be deleted';
    END IF;

    IF OLD.status <> 'draft' AND (
        NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
        OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
        OR NEW.consultation_id IS DISTINCT FROM OLD.consultation_id
        OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
        OR NEW.issued_by_user_id IS DISTINCT FROM OLD.issued_by_user_id
        OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
        OR NEW.currency IS DISTINCT FROM OLD.currency
        OR NEW.exchange_rate_to_usd IS DISTINCT FROM OLD.exchange_rate_to_usd
        OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
        OR NEW.discount IS DISTINCT FROM OLD.discount
        OR NEW.tax IS DISTINCT FROM OLD.tax
        OR NEW.total IS DISTINCT FROM OLD.total
        OR NEW.total_usd IS DISTINCT FROM OLD.total_usd
        OR NEW.notes IS DISTINCT FROM OLD.notes
        OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    ) THEN
        RAISE EXCEPTION 'Issued invoice financial data is immutable';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF OLD.status = 'draft' AND NEW.status = 'pending' AND action_name = 'issue' THEN
            IF NEW.invoice_number IS NULL OR NEW.issued_at IS NULL
               OR NEW.exchange_rate_to_usd IS NULL OR NEW.total_usd IS NULL
               OR NEW.total <> NEW.subtotal - NEW.discount + NEW.tax
               OR NEW.subtotal <> COALESCE((
                   SELECT SUM(line_total) FROM invoice_items WHERE invoice_id = OLD.id
               ), 0)
               OR NEW.total_usd <> round(NEW.total * NEW.exchange_rate_to_usd, 2)
               OR NOT EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = OLD.id) THEN
                RAISE EXCEPTION 'An invoice must have items and an exchange-rate snapshot before issue';
            END IF;
        ELSIF OLD.status = 'draft' AND NEW.status = 'void' AND action_name = 'void' THEN
            NULL;
        ELSIF OLD.status = 'pending' AND NEW.status = 'paid' AND action_name = 'payment' THEN
            IF COALESCE((
                SELECT SUM(CASE WHEN transaction_type = 'payment' THEN amount_usd ELSE -amount_usd END)
                FROM billing_transactions WHERE invoice_id = OLD.id
            ), 0) < OLD.total_usd THEN
                RAISE EXCEPTION 'An invoice can only be marked paid when its balance is zero';
            END IF;
        ELSIF OLD.status = 'paid' AND NEW.status = 'pending' AND action_name = 'refund' THEN
            IF COALESCE((
                SELECT SUM(CASE WHEN transaction_type = 'payment' THEN amount_usd ELSE -amount_usd END)
                FROM billing_transactions WHERE invoice_id = OLD.id
            ), 0) >= OLD.total_usd THEN
                RAISE EXCEPTION 'A refunded invoice must have an outstanding balance';
            END IF;
        ELSIF OLD.status = 'pending' AND NEW.status = 'void' AND action_name = 'void' THEN
            IF EXISTS (
                SELECT 1
                FROM billing_transactions payment
                WHERE payment.invoice_id = OLD.id
                  AND payment.transaction_type = 'payment'
                  AND NOT EXISTS (
                      SELECT 1 FROM billing_transactions refund
                      WHERE refund.reversal_of_transaction_id = payment.id
                  )
            ) THEN
                RAISE EXCEPTION 'Every payment must be reversed before voiding an invoice';
            END IF;
        ELSE
            RAISE EXCEPTION 'Invalid invoice status transition';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_billing_invoice_item()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    old_invoice_status TEXT;
    new_invoice_status TEXT;
    service_type TEXT;
    invoice_patient_id INTEGER;
    invoice_branch_id INTEGER;
    source_patient_id INTEGER;
    source_branch_id INTEGER;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        SELECT status INTO old_invoice_status
        FROM invoices WHERE id = OLD.invoice_id FOR SHARE;
        IF old_invoice_status IS DISTINCT FROM 'draft' THEN
            RAISE EXCEPTION 'Items of an issued invoice are immutable';
        END IF;
    END IF;

    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        SELECT status INTO new_invoice_status
        FROM invoices WHERE id = NEW.invoice_id FOR SHARE;
        IF new_invoice_status IS DISTINCT FROM 'draft' THEN
            RAISE EXCEPTION 'Items of an issued invoice are immutable';
        END IF;
    END IF;

    IF TG_OP IN ('INSERT', 'UPDATE') AND (
        NEW.service_id IS NULL
        OR NEW.base_unit_price_usd IS NULL
        OR (NEW.category = 'consultation' AND NEW.consultation_id IS NULL)
        OR (NEW.category = 'procedure' AND NEW.procedure_id IS NULL)
        OR (NEW.category = 'study' AND NEW.study_order_id IS NULL)
    ) THEN
        RAISE EXCEPTION 'A billing item requires a catalog service, USD price snapshot, and matching clinical source';
    END IF;

    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        SELECT s.service_type INTO service_type
        FROM billing_services s WHERE s.id = NEW.service_id;
        IF service_type IS DISTINCT FROM NEW.category
           OR (NEW.category = 'consultation'
               AND (NEW.consultation_id IS NULL OR NEW.procedure_id IS NOT NULL OR NEW.study_order_id IS NOT NULL))
           OR (NEW.category = 'procedure'
               AND (NEW.procedure_id IS NULL OR NEW.consultation_id IS NOT NULL OR NEW.study_order_id IS NOT NULL))
           OR (NEW.category = 'study'
               AND (NEW.study_order_id IS NULL OR NEW.procedure_id IS NOT NULL OR NEW.consultation_id IS NOT NULL)) THEN
            RAISE EXCEPTION 'The clinical source must match the catalog service type';
        END IF;

        SELECT patient_id, branch_id INTO invoice_patient_id, invoice_branch_id
        FROM invoices WHERE id = NEW.invoice_id;

        IF NEW.category = 'consultation' THEN
            SELECT mc.patient_id, a.branch_id INTO source_patient_id, source_branch_id
            FROM medical_consultations mc
            LEFT JOIN appointments a ON a.id = mc.appointment_id
            WHERE mc.id = NEW.consultation_id;
        ELSIF NEW.category = 'procedure' THEN
            SELECT mc.patient_id, a.branch_id INTO source_patient_id, source_branch_id
            FROM minor_procedures mp
            JOIN medical_consultations mc ON mc.id = mp.consultation_id
            LEFT JOIN appointments a ON a.id = mc.appointment_id
            WHERE mp.id = NEW.procedure_id AND mp.status = 'completed';
        ELSE
            SELECT mc.patient_id, a.branch_id INTO source_patient_id, source_branch_id
            FROM study_orders so
            JOIN medical_consultations mc ON mc.id = so.consultation_id
            LEFT JOIN appointments a ON a.id = mc.appointment_id
            WHERE so.id = NEW.study_order_id AND so.status <> 'cancelled';
        END IF;

        IF source_patient_id IS DISTINCT FROM invoice_patient_id
           OR (source_branch_id IS NOT NULL AND source_branch_id <> invoice_branch_id) THEN
            RAISE EXCEPTION 'The billing source must belong to the invoice patient and branch';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_billing_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    invoice_row invoices%ROWTYPE;
    original_row billing_transactions%ROWTYPE;
    net_paid NUMERIC(12, 2);
BEGIN
    SELECT * INTO invoice_row
    FROM invoices
    WHERE id = NEW.invoice_id
    FOR UPDATE;

    IF NOT FOUND OR NEW.branch_id <> invoice_row.branch_id THEN
        RAISE EXCEPTION 'Transaction invoice or branch does not match';
    END IF;

    IF NEW.transaction_type = 'payment' THEN
        IF invoice_row.status <> 'pending' THEN
            RAISE EXCEPTION 'Payments can only be recorded against pending invoices';
        END IF;
        SELECT COALESCE(SUM(
            CASE WHEN transaction_type = 'payment' THEN amount_usd ELSE -amount_usd END
        ), 0) INTO net_paid
        FROM billing_transactions
        WHERE invoice_id = NEW.invoice_id;
        IF net_paid + NEW.amount_usd > invoice_row.total_usd THEN
            RAISE EXCEPTION 'Payment exceeds the outstanding invoice balance';
        END IF;
    ELSE
        SELECT * INTO original_row
        FROM billing_transactions
        WHERE id = NEW.reversal_of_transaction_id
          AND transaction_type = 'payment';
        IF NOT FOUND
           OR original_row.invoice_id <> NEW.invoice_id
           OR original_row.branch_id <> NEW.branch_id
           OR original_row.amount <> NEW.amount
           OR original_row.currency <> NEW.currency
           OR original_row.exchange_rate_to_usd <> NEW.exchange_rate_to_usd
           OR original_row.amount_usd <> NEW.amount_usd THEN
            RAISE EXCEPTION 'A refund must exactly reverse its original payment';
        END IF;
        IF invoice_row.status NOT IN ('pending', 'paid') THEN
            RAISE EXCEPTION 'Only pending or paid invoices can have payments refunded';
        END IF;
    END IF;

    IF round(NEW.amount * NEW.exchange_rate_to_usd, 2) <> NEW.amount_usd THEN
        RAISE EXCEPTION 'Transaction USD snapshot does not match the stored exchange rate';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_billing_guard ON invoices;
CREATE TRIGGER invoices_billing_guard
BEFORE UPDATE OR DELETE ON invoices
FOR EACH ROW EXECUTE FUNCTION protect_billing_invoice();

DROP TRIGGER IF EXISTS invoice_items_billing_guard ON invoice_items;
CREATE TRIGGER invoice_items_billing_guard
BEFORE INSERT OR UPDATE OR DELETE ON invoice_items
FOR EACH ROW EXECUTE FUNCTION protect_billing_invoice_item();

DROP TRIGGER IF EXISTS billing_transactions_validate ON billing_transactions;
CREATE TRIGGER billing_transactions_validate
BEFORE INSERT ON billing_transactions
FOR EACH ROW EXECUTE FUNCTION validate_billing_transaction();

DROP TRIGGER IF EXISTS billing_transactions_immutable ON billing_transactions;
CREATE TRIGGER billing_transactions_immutable
BEFORE UPDATE OR DELETE ON billing_transactions
FOR EACH ROW EXECUTE FUNCTION reject_billing_record_mutation();

DROP TRIGGER IF EXISTS billing_exchange_rates_immutable ON billing_exchange_rates;
CREATE TRIGGER billing_exchange_rates_immutable
BEFORE UPDATE OR DELETE ON billing_exchange_rates
FOR EACH ROW EXECUTE FUNCTION reject_billing_record_mutation();

DROP TRIGGER IF EXISTS billing_audit_events_immutable ON billing_audit_events;
CREATE TRIGGER billing_audit_events_immutable
BEFORE UPDATE OR DELETE ON billing_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_billing_record_mutation();

CREATE INDEX IF NOT EXISTS invoices_branch_status_created_idx
    ON invoices (branch_id, status, created_at DESC);

COMMIT;
