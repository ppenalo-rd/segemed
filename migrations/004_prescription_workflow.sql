BEGIN;

CREATE INDEX IF NOT EXISTS prescriptions_consultation_status_idx
    ON prescriptions (consultation_id, status, created_at DESC);

CREATE OR REPLACE FUNCTION protect_signed_prescription()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.signed_at IS NOT NULL THEN
        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'A signed prescription cannot be deleted';
        END IF;
        IF NEW.consultation_id IS DISTINCT FROM OLD.consultation_id
           OR NEW.prescribed_by_user_id IS DISTINCT FROM OLD.prescribed_by_user_id
           OR NEW.instructions IS DISTINCT FROM OLD.instructions
           OR NEW.signed_at IS DISTINCT FROM OLD.signed_at THEN
            RAISE EXCEPTION 'Signed prescription content is immutable';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prescriptions_signed_immutable ON prescriptions;
CREATE TRIGGER prescriptions_signed_immutable
BEFORE UPDATE OR DELETE ON prescriptions
FOR EACH ROW EXECUTE FUNCTION protect_signed_prescription();

CREATE OR REPLACE FUNCTION protect_signed_prescription_item()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM prescriptions
        WHERE id = OLD.prescription_id AND signed_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Items of a signed prescription are immutable';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prescription_items_signed_immutable ON prescription_items;
CREATE TRIGGER prescription_items_signed_immutable
BEFORE UPDATE OR DELETE ON prescription_items
FOR EACH ROW EXECUTE FUNCTION protect_signed_prescription_item();

COMMIT;
