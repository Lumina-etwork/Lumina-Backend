-- Migration: Add tamper-evident hash-chain fields to admin audit logs

ALTER TABLE admin_audit_logs
  ADD COLUMN IF NOT EXISTS sequence_number BIGINT,
  ADD COLUMN IF NOT EXISTS previous_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS audit_hash CHAR(64);

-- Existing rows should be backfilled by the deployment runbook before these columns
-- are promoted to NOT NULL in production. Empty deployments can apply constraints immediately.
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_audit_logs_sequence_number
  ON admin_audit_logs(sequence_number)
  WHERE sequence_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_previous_hash ON admin_audit_logs(previous_hash);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_audit_hash ON admin_audit_logs(audit_hash);

COMMENT ON COLUMN admin_audit_logs.sequence_number IS 'Monotonic audit sequence used for tamper-evident verification';
COMMENT ON COLUMN admin_audit_logs.previous_hash IS 'SHA-256 hash of the previous audit event or genesis hash';
COMMENT ON COLUMN admin_audit_logs.audit_hash IS 'SHA-256 hash over canonical audit event fields and previous_hash';
