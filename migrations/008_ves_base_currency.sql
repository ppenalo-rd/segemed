BEGIN;

INSERT INTO billing_currencies (code, name, active)
VALUES ('VES', 'Bolívar venezolano', TRUE)
ON CONFLICT (code) DO NOTHING;

INSERT INTO billing_currencies (code, name, active)
VALUES ('USD', 'Dólar estadounidense', TRUE)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS billing_settings (
    id SMALLINT PRIMARY KEY DEFAULT 1,
    base_currency CHAR(3) NOT NULL REFERENCES billing_currencies(code),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT billing_settings_singleton_check CHECK (id = 1)
);

INSERT INTO billing_settings (id, base_currency)
VALUES (1, 'VES')
ON CONFLICT (id) DO UPDATE
SET base_currency = EXCLUDED.base_currency,
    updated_at = CURRENT_TIMESTAMP;

ALTER TABLE billing_exchange_rates
    ADD COLUMN IF NOT EXISTS units_per_usd NUMERIC(18, 8);

ALTER TABLE invoices DISABLE TRIGGER invoices_billing_guard;
ALTER TABLE billing_transactions DISABLE TRIGGER billing_transactions_immutable;
ALTER TABLE billing_exchange_rates DISABLE TRIGGER billing_exchange_rates_immutable;

UPDATE billing_exchange_rates
SET units_per_usd = round(1::NUMERIC / rate_to_usd, 8)
WHERE units_per_usd IS NULL;

ALTER TABLE billing_exchange_rates
    ALTER COLUMN units_per_usd SET NOT NULL;

ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS exchange_rate_units_per_usd NUMERIC(18, 8);

UPDATE invoices
SET exchange_rate_units_per_usd = round(1::NUMERIC / exchange_rate_to_usd, 8)
WHERE exchange_rate_units_per_usd IS NULL
  AND exchange_rate_to_usd IS NOT NULL;

ALTER TABLE billing_transactions
    ADD COLUMN IF NOT EXISTS exchange_rate_units_per_usd NUMERIC(18, 8);

UPDATE billing_transactions
SET exchange_rate_units_per_usd = round(1::NUMERIC / exchange_rate_to_usd, 8)
WHERE exchange_rate_units_per_usd IS NULL;

ALTER TABLE invoices ENABLE TRIGGER invoices_billing_guard;
ALTER TABLE billing_transactions ENABLE TRIGGER billing_transactions_immutable;
ALTER TABLE billing_exchange_rates ENABLE TRIGGER billing_exchange_rates_immutable;

ALTER TABLE billing_transactions
    ALTER COLUMN exchange_rate_units_per_usd SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'billing_exchange_rates_units_per_usd_check'
          AND conrelid = 'billing_exchange_rates'::regclass
    ) THEN
        ALTER TABLE billing_exchange_rates
            ADD CONSTRAINT billing_exchange_rates_units_per_usd_check CHECK (units_per_usd > 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'invoices_exchange_rate_units_per_usd_check'
          AND conrelid = 'invoices'::regclass
    ) THEN
        ALTER TABLE invoices
            ADD CONSTRAINT invoices_exchange_rate_units_per_usd_check
            CHECK (exchange_rate_units_per_usd IS NULL OR exchange_rate_units_per_usd > 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'billing_transactions_units_per_usd_check'
          AND conrelid = 'billing_transactions'::regclass
    ) THEN
        ALTER TABLE billing_transactions
            ADD CONSTRAINT billing_transactions_units_per_usd_check
            CHECK (exchange_rate_units_per_usd > 0);
    END IF;
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
        OR NEW.exchange_rate_units_per_usd IS DISTINCT FROM OLD.exchange_rate_units_per_usd
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
               OR NEW.exchange_rate_to_usd IS NULL
               OR NEW.exchange_rate_units_per_usd IS NULL
               OR NEW.total_usd IS NULL
               OR NEW.total <> NEW.subtotal - NEW.discount + NEW.tax
               OR NEW.subtotal <> COALESCE((
                   SELECT SUM(line_total) FROM invoice_items WHERE invoice_id = OLD.id
               ), 0)
               OR NEW.total_usd <> round(NEW.total / NEW.exchange_rate_units_per_usd, 2)
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
           OR original_row.exchange_rate_units_per_usd <> NEW.exchange_rate_units_per_usd
           OR original_row.amount_usd <> NEW.amount_usd THEN
            RAISE EXCEPTION 'A refund must exactly reverse its original payment';
        END IF;
        IF invoice_row.status NOT IN ('pending', 'paid') THEN
            RAISE EXCEPTION 'Only pending or paid invoices can have payments refunded';
        END IF;
    END IF;

    IF round(NEW.amount / NEW.exchange_rate_units_per_usd, 2) <> NEW.amount_usd THEN
        RAISE EXCEPTION 'Transaction USD snapshot does not match the stored exchange rate';
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;
