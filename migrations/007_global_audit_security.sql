BEGIN;

CREATE INDEX IF NOT EXISTS access_audit_event_time_idx
    ON access_audit_logs (event_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS access_audit_resource_time_idx
    ON access_audit_logs (resource_type, resource_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION reject_audit_log_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Audit records are immutable';
END;
$$;

DROP TRIGGER IF EXISTS access_audit_logs_immutable ON access_audit_logs;
CREATE TRIGGER access_audit_logs_immutable
BEFORE UPDATE OR DELETE ON access_audit_logs
FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();

COMMIT;
