CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$ BEGIN
  CREATE TYPE scheduled_job_status AS ENUM ('queued', 'leased', 'completed', 'failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(128) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status scheduled_job_status NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 0,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  worker_id VARCHAR(128),
  lease_token UUID,
  leased_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  result JSONB,
  completed_at TIMESTAMPTZ,
  idempotency_key VARCHAR(256) UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scheduled_jobs_claim_idx
  ON scheduled_jobs (status, run_at, priority DESC, id)
  WHERE status IN ('queued', 'leased');

CREATE INDEX IF NOT EXISTS scheduled_jobs_lease_expiry_idx
  ON scheduled_jobs (lease_expires_at)
  WHERE status = 'leased';
