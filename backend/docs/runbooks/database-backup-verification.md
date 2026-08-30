# Database Backup Verification Runbook

## Enablement

1. Set `BACKUP_ENCRYPTION_KEY` (>= 16 chars) via the secrets service or
   environment. Without it, artifacts are stored gzip-only and production
   should not proceed.
2. Set `PG_DB`/`PG_USER`/`PG_HOST`/`PG_PORT`/`PG_PASSWORD` (or the `DB_*`
   equivalents). The user needs `CREATEDB` privileges for restore testing.
3. (Optional) Set `BACKUP_S3_BUCKET` and `BACKUP_S3_UPLOAD=true` for an
   off-site copy.
4. Deploy with `BACKUP_ENABLED=true` and `BACKUP_RESTORE_TEST_ENABLED=true`.
5. Confirm the schedules are active in the logs
   (`[BackupVerification] Scheduling daily backup+verify at "0 2 * * *"`).
6. Confirm `backup_verification_status{operation="backup"}` becomes 1 after
   the first run.

## Manual runs

Full cycle (backup + verify + restore test):

```bash
cd backend
node scripts/run-backup-verification.js
```

Restore test of the latest artifact only:

```bash
node scripts/run-backup-verification.js --restore-test
```

Backup + integrity verification only (no restore test):

```bash
node scripts/run-backup-verification.js --backup-only
```

Via the API:

```bash
curl -X POST http://localhost:4000/api/admin/backups/run
curl -X POST http://localhost:4000/api/admin/backups/restore-test
curl http://localhost:4000/api/admin/backups/status
curl http://localhost:4000/api/admin/backups/history?limit=20
```

## Alert responses

### DatabaseBackupFailed

Query: `increase(backup_failures_total{operation="backup"}[5m]) > 0`

Action: check the backup history (`/api/admin/backups/history`), verify the
database is reachable, then trigger a manual run. If `pg_dump` fails, fix the
source issue before the next scheduled window.

### DatabaseBackupStale

Query: `time() - backup_last_success_timestamp{operation="backup"} > 36 * 3600`

Action: confirm the job is running (`BACKUP_ENABLED=true`, cron active) and no
alerts are suppressed. Trigger a manual backup and confirm the metric updates.

### DatabaseBackupVerificationFailed

Action: the artifact failed checksum or dump-content checks. Treat the latest
artifact as unverified: do not use it for a restore until a manual
`--restore-test` passes, and investigate corruption at rest (disk, S3).

### DatabaseBackupRestoreTestFailed

Action: the backup restored but the scratch database did not reproduce the
source schema/row counts. Inspect the row deltas in the report
(`backup_restore_test_row_delta`), then re-run manually. If it persists, treat
the backup as not restorable and investigate what changed in the source schema.

### DatabaseBackupRestoreTestStale

Action: no successful restore test in 8 days. Confirm the weekly cron fired
and there were no failures; run `node scripts/run-backup-verification.js
--restore-test` to re-establish the last-success timestamp.

### DatabaseBackupRestoreRowDeltaMismatch

Action: compare the live database to the restored copy for the flagged table.
A non-zero delta usually indicates a backup taken mid-write or a schema change;
verify the source and re-run the restore test.

## Disaster recovery (manual restore)

1. Select an artifact (prefer the newest one whose manifest checksum verifies):
   ```bash
   ls -la $BACKUP_DIR/backup_*.sql.gz.enc
   ```
2. Decrypt and decompress to a plain SQL file (or restore directly):
   ```bash
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
     -pass env:BACKUP_ENCRYPTION_KEY \
     -in  $BACKUP_DIR/backup_<ts>.sql.gz.enc \
     -out /tmp/backup.sql.gz
   gunzip -c /tmp/backup.sql.gz > /tmp/backup.sql
   ```
3. Verify the dump before touching the live database:
   ```bash
   head -c 512 /tmp/backup.sql            # expect "PostgreSQL database dump"
   grep -c '^CREATE TABLE' /tmp/backup.sql
   ```
4. Restore into the target database (this replaces data):
   ```bash
   psql -h $PG_HOST -p $PG_PORT -U $PG_USER -d $PG_DB \
     -v ON_ERROR_STOP=1 -f /tmp/backup.sql
   ```
5. Smoke-check the restored database (table count, key row counts, and a
   representative query), then update the runbook timestamp.

## Disabling / rollback

- Stop new runs: set `BACKUP_ENABLED=false` (and `BACKUP_RESTORE_TEST_ENABLED=false`)
  and redeploy — manual/API triggers still work for emergencies.
- Roll back the feature: revert the deployment; no schema migrations are
  involved, so rollback is a plain image revert.
