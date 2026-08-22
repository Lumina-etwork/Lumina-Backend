-- Migration: Dead Letter Queue persistence table
-- Issue #104: Dead Letter Queue for Failed Asynchronous Message Processing
--
-- This table provides a PostgreSQL-backed audit trail for messages that have
-- exhausted all retry attempts.  The BullMQ/Redis layer handles live queueing;
-- this table enables long-term retention, querying, and compliance reporting.
--
-- Partitioned by day on created_at (RANGE) so old partitions can be dropped
-- cheaply as part of the 7-day TTL purge job.

CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id              UUID                     NOT NULL DEFAULT gen_random_uuid(),
  source_queue    TEXT                     NOT NULL,
  source_job_id   TEXT                     NOT NULL,
  payload         JSONB                    NOT NULL DEFAULT '{}',
  error_type      TEXT,
  stack_trace     TEXT,
  retry_count     INTEGER                  NOT NULL DEFAULT 0,
  failed_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create an initial set of daily partitions covering the current week plus one
-- day ahead.  The purge job (dlqPurgeJob) is responsible for creating future
-- partitions and dropping partitions older than 7 days.
DO $$
DECLARE
  partition_date DATE;
  partition_name TEXT;
  start_ts       TIMESTAMP WITH TIME ZONE;
  end_ts         TIMESTAMP WITH TIME ZONE;
BEGIN
  FOR i IN -1..7 LOOP
    partition_date := CURRENT_DATE + i;
    partition_name := 'dead_letter_queue_' || to_char(partition_date, 'YYYY_MM_DD');
    start_ts       := partition_date::TIMESTAMP WITH TIME ZONE;
    end_ts         := (partition_date + 1)::TIMESTAMP WITH TIME ZONE;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = partition_name
        AND n.nspname = current_schema()
    ) THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF dead_letter_queue FOR VALUES FROM (%L) TO (%L)',
        partition_name, start_ts, end_ts
      );
    END IF;
  END LOOP;
END;
$$;

-- Indexes on the parent table are automatically inherited by all partitions.
CREATE INDEX IF NOT EXISTS idx_dlq_source_queue  ON dead_letter_queue (source_queue);
CREATE INDEX IF NOT EXISTS idx_dlq_error_type    ON dead_letter_queue (error_type);
CREATE INDEX IF NOT EXISTS idx_dlq_failed_at     ON dead_letter_queue (failed_at DESC);
CREATE INDEX IF NOT EXISTS idx_dlq_created_at    ON dead_letter_queue (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dlq_source_job_id ON dead_letter_queue (source_job_id);
