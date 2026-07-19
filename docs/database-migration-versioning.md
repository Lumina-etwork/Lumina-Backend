# Database Migration Versioning and Rollback Architecture

## Overview

Lumina uses a versioned migration runner backed by the `schema_migrations` table. Each migration file is named `<version>_<description>.sql` or `<version>_<description>.js`, is applied once, and is recorded with its SHA-256 checksum, execution time, and optional rollback SQL.

## Migration file contract

SQL migrations may include explicit sections:

```sql
-- +migrate Up
CREATE TABLE example(id BIGSERIAL PRIMARY KEY);

-- +migrate Down
DROP TABLE example;
```

JavaScript migrations must export `up(client)` and `down(client)` functions. The runner executes every migration inside a database transaction and marks rollbacks with `rolled_back_at` so the same version can be re-applied during a fix-forward.

## Operations

- Apply pending migrations: `npm run migrate`.
- Roll back the latest migration: `npm run migrate:rollback`.
- Roll back multiple migrations: `MIGRATION_STEPS=3 npm run migrate:rollback`.
- Override the migration directory for canaries or service-local migrations: `MIGRATIONS_DIR=/path/to/migrations npm run migrate`.

## Blue-green and canary deployment

1. Apply backward-compatible migrations against the shared database before shifting traffic.
2. Deploy green with `MIGRATIONS_DIR` pinned to the reviewed migration bundle.
3. Shift 5% traffic to green and monitor migration latency, application error rate, and rollback availability.
4. Increase traffic only if P99 request latency remains below 100 ms on critical paths and no migration errors are observed.
5. Keep destructive down migrations disabled until the previous blue version is fully drained.

## Monitoring and alerts

Emit the following metrics from the migration command wrapper or deployment job:

- `db_migration_duration_ms` with labels `version` and `direction`.
- `db_migration_failures_total` with labels `version` and `direction`.
- `db_migration_pending_total` for unapplied migrations in a release bundle.

Alert when a migration fails, when pending migrations remain after deployment, or when P99 migration execution time exceeds 30 seconds during deploy windows.

## Security review checklist

- No dynamic SQL identifiers unless validated by the migration runner.
- Every schema change has a rollback section or documented fix-forward plan.
- Data migrations are idempotent and scoped by primary-key ranges for large tables.
- Privilege changes are reviewed separately from schema changes.
