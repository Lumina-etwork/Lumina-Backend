-- Migration: PostgreSQL Query Performance Monitoring tables
-- Issue #49: PostgreSQL Query Performance Monitoring and Slow Query Alerting

CREATE TABLE IF NOT EXISTS slow_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_query TEXT NOT NULL,
  raw_query TEXT,
  query_type VARCHAR(20) NOT NULL,
  table_name VARCHAR(255),
  application_name VARCHAR(100),
  call_count INTEGER NOT NULL DEFAULT 0,
  mean_time_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_time_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
  stddev_time_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
  min_time_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
  max_time_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_seen TIMESTAMP WITH TIME ZONE,
  first_seen TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  plan_data JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_slow_queries_normalized ON slow_queries (normalized_query);
CREATE INDEX IF NOT EXISTS idx_slow_queries_type ON slow_queries (query_type);
CREATE INDEX IF NOT EXISTS idx_slow_queries_table ON slow_queries (table_name);
CREATE INDEX IF NOT EXISTS idx_slow_queries_mean_time ON slow_queries (mean_time_ms DESC);
CREATE INDEX IF NOT EXISTS idx_slow_queries_last_seen ON slow_queries (last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_slow_queries_app ON slow_queries (application_name);

CREATE TABLE IF NOT EXISTS slow_query_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slow_query_id UUID NOT NULL REFERENCES slow_queries(id) ON DELETE CASCADE,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('warning', 'critical', 'emergency')),
  threshold_ms DOUBLE PRECISION NOT NULL,
  actual_mean_time_ms DOUBLE PRECISION NOT NULL,
  fire_count INTEGER NOT NULL DEFAULT 1,
  first_fired_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_fired_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_by VARCHAR(255),
  acknowledged_at TIMESTAMP WITH TIME ZONE,
  pagerduty_incident_id VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_slow_query_alerts_query_id ON slow_query_alerts (slow_query_id);
CREATE INDEX IF NOT EXISTS idx_slow_query_alerts_severity ON slow_query_alerts (severity);
CREATE INDEX IF NOT EXISTS idx_slow_query_alerts_last_fired ON slow_query_alerts (last_fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_slow_query_alerts_acknowledged ON slow_query_alerts (acknowledged);
