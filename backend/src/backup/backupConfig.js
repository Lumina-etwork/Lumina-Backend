const path = require("path");

/**
 * Configuration for the Scheduled Database Backup Verification subsystem.
 *
 * All values are overridable through environment variables so the same code
 * can run with different policies in dev, staging, and production. Secrets
 * (encryption key, database password) are never logged and should be supplied
 * through the secrets service / environment in production.
 */

const BACKUP_CRON_PATTERN =
  /^(\*|[0-5]?\d|\*\/\d{1,2}|[0-5]?\d(?:,[0-5]?\d)*|\d{1,2}(?:-\d{1,2})?)( (\*|[0-5]?\d|\*\/\d{1,2}|[0-5]?\d(?:,[0-5]?\d)*|\d{1,2}(?:-\d{1,2})?)){4}$/;

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseIntStrict(value, fallback, { min, max } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  if (min !== undefined && parsed < min) return fallback;
  if (max !== undefined && parsed > max) return fallback;
  return parsed;
}

/**
 * Parse retention days strictly: an explicitly provided invalid value is kept
 * as-is so that configuration validation can reject it loudly instead of
 * silently falling back to the default (which could lengthen retention).
 */
function parseRetentionDays(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 3650) return value;
  return parsed;
}

function buildConfig(env = process.env) {
  const database = env.PG_DB || env.DB_NAME || "vesting_vault";
  const user = env.PG_USER || env.DB_USER || "postgres";
  const host = env.PG_HOST || env.DB_HOST || "localhost";
  const port = parseIntStrict(env.PG_PORT || env.DB_PORT, 5432, { min: 1, max: 65535 });
  const password = env.PG_PASSWORD || env.DB_PASSWORD || "";

  const config = {
    // Master switch for the scheduled job (manual/API triggers still work).
    enabled: parseBool(env.BACKUP_ENABLED, true),

    // Where backup artifacts and verification history are stored.
    backupDir: env.BACKUP_DIR || path.resolve(process.cwd(), "backups"),

    // Cron expressions. Backup runs daily at 02:00 by default; the restore
    // test runs weekly (Sunday 04:00) against the latest verified backup.
    backupCron: env.BACKUP_CRON || "0 2 * * *",
    restoreTestCron: env.BACKUP_RESTORE_TEST_CRON || "0 4 * * 0",
    restoreTestEnabled: parseBool(env.BACKUP_RESTORE_TEST_ENABLED, true),

    // Local retention: how many days of encrypted artifacts to keep.
    retentionDays: parseRetentionDays(env.BACKUP_RETENTION_DAYS, 30),

    // AES-256 encryption key. When unset, backups are stored gzip-only, which
    // is acceptable for throwaway environments but not for production.
    encryptionKey: env.BACKUP_ENCRYPTION_KEY || null,

    // Optional S3 off-site copy (aws cli). Bucket form: s3://bucket/prefix
    s3Bucket: env.BACKUP_S3_BUCKET || null,
    uploadToS3: parseBool(env.BACKUP_S3_UPLOAD, false),

    // Key tables included in the restore-test row-count comparison. The
    // verification fails when any of these tables has a different row count
    // in the restored scratch database.
    verifyTables: (env.BACKUP_VERIFY_TABLES || "vaults,sub_schedules,beneficiaries")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t)),

    // Scratch database used for restore testing. Created before the restore
    // and dropped afterwards; never points at the live database.
    scratchDbPrefix: env.BACKUP_SCRATCH_DB_PREFIX || "lumina_restore_test_",
    maintenanceDatabase: env.BACKUP_MAINTENANCE_DB || "postgres",

    // How many history entries to keep in the local JSONL history file.
    maxHistoryEntries: parseIntStrict(env.BACKUP_HISTORY_LIMIT, 500, { min: 10, max: 100000 }),

    pg: { database, user, host, port, password },
  };

  return config;
}

function validateBackupConfig(config) {
  const errors = [];

  if (!BACKUP_CRON_PATTERN.test(config.backupCron)) {
    errors.push(`backupCron must be a 5-field cron expression, got "${config.backupCron}"`);
  }
  if (!BACKUP_CRON_PATTERN.test(config.restoreTestCron)) {
    errors.push(
      `restoreTestCron must be a 5-field cron expression, got "${config.restoreTestCron}"`,
    );
  }
  if (
    !Number.isInteger(config.retentionDays) ||
    config.retentionDays < 1 ||
    config.retentionDays > 3650
  ) {
    errors.push(
      `retentionDays must be an integer between 1 and 3650, got "${config.retentionDays}"`,
    );
  }
  if (!config.backupDir || typeof config.backupDir !== "string") {
    errors.push("backupDir must be a non-empty path");
  }
  if (!config.scratchDbPrefix || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(config.scratchDbPrefix)) {
    errors.push(
      `scratchDbPrefix must be a valid PostgreSQL identifier prefix, got "${config.scratchDbPrefix}"`,
    );
  }
  if (config.uploadToS3 && (!config.s3Bucket || !config.s3Bucket.startsWith("s3://"))) {
    errors.push("s3Bucket must be an s3:// URI when BACKUP_S3_UPLOAD is enabled");
  }
  if (config.encryptionKey && config.encryptionKey.length < 16) {
    errors.push("BACKUP_ENCRYPTION_KEY must be at least 16 characters");
  }
  if (!config.pg.host || !config.pg.database || !config.pg.user) {
    errors.push("database host, database name, and user are required");
  }

  if (errors.length) {
    const err = new Error(`Invalid backup configuration: ${errors.join("; ")}`);
    err.name = "BackupConfigError";
    throw err;
  }

  return config;
}

/** Load and validate the backup configuration from the environment. */
function loadBackupConfig(env = process.env) {
  return validateBackupConfig(buildConfig(env));
}

module.exports = { loadBackupConfig, validateBackupConfig, buildConfig, BACKUP_CRON_PATTERN };
