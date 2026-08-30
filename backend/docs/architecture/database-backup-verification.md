# Scheduled Database Backup Verification Architecture

## Overview

The Lumina backend depends on PostgreSQL for all persistent state. A backup is
only useful if it can actually be restored. This subsystem guarantees that by
running a three-stage pipeline on a schedule:

1. **Backup** — a consistent `pg_dump` snapshot is compressed, encrypted at
   rest with AES-256, and optionally copied off-site to S3.
2. **Verification** — the artifact is decrypted, decompressed, checksum-verified
   against its manifest, and checked for a valid PostgreSQL dump header and
   `CREATE TABLE` statements.
3. **Restore testing** — the verified backup is restored into an isolated
   scratch database, and table/row counts are compared against the live
   database. The scratch database is dropped afterwards.

Every run emits Prometheus metrics, appends to a local JSONL history file, and
exposes status through an admin API so a "backup succeeded" claim is backed by
evidence that the data is actually restorable.

## Pipeline

```
                       ┌──────────────────────────────────────────────┐
                       │            BackupVerificationJob              │
                       │  (node-cron, process-local schedules)        │
                       └───────┬──────────────────┬───────────────────┘
                               │ daily            │ weekly
                    ┌──────────▼──────────┐  ┌────▼──────────────────────┐
                    │   runFullVerification│  │   verifyLatestBackup      │
                    └──────────┬──────────┘  └────┬──────────────────────┘
                               │                  │
                    ┌──────────▼──────────────────▼──────────┐
                    │         BackupVerificationService       │
                    └────────────────────────────────────────┘
   takeBackup:  pg_dump ──▶ gzip (zlib) ──▶ AES-256 (openssl) ──▶ [S3] ──▶ manifest
   verifyBackup: openssl -d ──▶ gunzip ──▶ sha256 vs manifest ──▶ header/tables check
   restoreTest:  CREATE scratch DB ──▶ psql restore ──▶ compare counts ──▶ DROP scratch DB
```

### Artifacts and manifests

Artifacts are stored in `BACKUP_DIR` (default `./backups`) as
`backup_YYYY-MM-DD_HH-MM-SS_SSS.sql.gz[.enc]`. A sibling
`backup_<timestamp>.manifest.json` records the SHA-256 digest of the plain SQL
dump and the encrypted artifact, size, source database, and creation time. The
manifest is the source of truth for the checksum comparison performed during
verification, which detects corruption or tampering.

### Restore testing

The restore test is the core of the feature. For each run it:

1. Creates a scratch database named `<BACKUP_SCRATCH_DB_PREFIX><epoch-ms>`
   (e.g. `lumina_restore_test_1724900000000`) via `psql`.
2. Restores the plain SQL dump with `ON_ERROR_STOP=1` so any SQL error fails
   the run loudly.
3. Compares the number of `public` schema tables, and the row count of each
   table in `BACKUP_VERIFY_TABLES` (default `vaults, sub_schedules,
   beneficiaries`), between the live database and the restored scratch
   database. Any delta (source − restored) other than 0 marks the run failed.
4. Drops the scratch database in a `finally` block (terminating lingering
   connections first), so a failed run can never leak a full copy of the data.

## Scheduling

Two independent `node-cron` schedules are managed by `BackupVerificationJob`:

| Schedule | Default | Action |
|----------|---------|--------|
| `BACKUP_CRON` | `0 2 * * *` (daily 02:00) | Backup + integrity verification |
| `BACKUP_RESTORE_TEST_CRON` | `0 4 * * 0` (Sunday 04:00) | Restore test of the latest verified artifact |

Both can be disabled with `BACKUP_ENABLED=false` (master switch) and
`BACKUP_RESTORE_TEST_ENABLED=false` (restore testing only). Schedules are
process-local, so exactly one backend instance should start the job — matching
the convention used by the other scheduled jobs in this repository.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `BACKUP_ENABLED` | `true` | Master switch for the scheduled job |
| `BACKUP_DIR` | `./backups` | Local artifact + history directory |
| `BACKUP_CRON` | `0 2 * * *` | Daily backup + verify schedule |
| `BACKUP_RESTORE_TEST_CRON` | `0 4 * * 0` | Weekly restore-test schedule |
| `BACKUP_RESTORE_TEST_ENABLED` | `true` | Enable/disable restore testing |
| `BACKUP_RETENTION_DAYS` | `30` | Local artifact retention window |
| `BACKUP_ENCRYPTION_KEY` | unset | AES-256 key (>= 16 chars; required in production) |
| `BACKUP_S3_BUCKET` | unset | Off-site copy target, e.g. `s3://lumina-backups/prod` |
| `BACKUP_S3_UPLOAD` | `false` | Enable the `aws s3 cp` off-site copy |
| `BACKUP_VERIFY_TABLES` | `vaults,sub_schedules,beneficiaries` | Tables compared in the restore test |
| `BACKUP_SCRATCH_DB_PREFIX` | `lumina_restore_test_` | Scratch database name prefix |
| `BACKUP_MAINTENANCE_DB` | `postgres` | Maintenance database for CREATE/DROP |
| `BACKUP_HISTORY_LIMIT` | `500` | JSONL history entries kept |
| `PG_DB`/`PG_USER`/`PG_HOST`/`PG_PORT`/`PG_PASSWORD` | DB_* fallbacks | PostgreSQL connection |

Configuration is validated at startup (`BackupConfigError` on invalid cron
expressions, retention windows, bucket URIs, or key lengths), so a typo fails
fast instead of silently mis-behaving.

## Security

- **Encryption at rest:** artifacts are encrypted with AES-256-CBC
  (OpenSSL, PBKDF2, 100k iterations). The key is read from
  `BACKUP_ENCRYPTION_KEY` / the secrets service and never logged.
- **Integrity:** SHA-256 digests recorded in the manifest are re-computed on
  verification, catching both corruption and tampering.
- **Scratch database isolation:** restore tests never touch the live database
  — they run against a dedicated database that is created and dropped per run.
- **No secrets in code:** credentials come from the environment/secrets
  service, matching the rest of the backend.

## Monitoring and alerting

Metrics are registered on the shared Prometheus registry (exposed at
`/metrics`) and documented in
`monitoring/prometheus/database-backup-verification-rules.yaml`:

- `backup_attempts_total{operation}` / `backup_failures_total{operation,reason}`
- `backup_duration_seconds{operation}` (histogram)
- `backup_size_bytes`
- `backup_verification_status{operation}` (1 = ok, 0 = failed)
- `backup_last_success_timestamp{operation}`
- `backup_restore_test_row_delta{table}` (source − restored)

Alerts: `DatabaseBackupFailed`, `DatabaseBackupStale` (>36h), `DatabaseBackupVerificationFailed`,
`DatabaseBackupRestoreTestFailed`, `DatabaseBackupRestoreTestStale` (>8d),
`DatabaseBackupRestoreRowDeltaMismatch`. A Grafana dashboard is provided at
`monitoring/grafana/dashboards/database-backup-verification.json`.

## Performance and availability

- The pipeline runs entirely off the request critical path; the <100 ms P99
  API target is unaffected.
- The job never blocks startup: it is started with the same try/catch guard as
  the other scheduled jobs, and a failure only surfaces through metrics,
  history, and alerts.
- Restore tests run against the maintenance/scratch databases with a bounded
  client query timeout, and the job is safe to run manually on demand.

## Deployment (blue-green / canary)

1. Deploy the new image to the green pool with `BACKUP_ENABLED=false` and
   `BACKUP_RESTORE_TEST_ENABLED=false`.
2. Send 5% canary traffic to green; verify `backup_verification_status` gauges
   appear and no configuration errors are logged.
3. Enable restore testing on green first (`BACKUP_RESTORE_TEST_ENABLED=true`)
   and confirm a successful `DatabaseBackupRestoreTestFailed`-free cycle.
4. Enable the full schedule (`BACKUP_ENABLED=true`) and promote green once a
   complete daily + weekly cycle passes.

## Restore procedure

Disaster recovery is covered in the
[Database Backup Verification Runbook](../runbooks/database-backup-verification.md).
In short: run `node scripts/run-backup-verification.js --restore-test` against
the newest artifact, or follow the manual restore steps there.
