const path = require("path");
const os = require("os");
const { loadBackupConfig, validateBackupConfig } = require("../../src/backup/backupConfig");

describe("backupConfig", () => {
  const tmpDir = path.join(os.tmpdir(), "lumina-backup-config-test");

  test("applies defaults when no environment variables are set", () => {
    const config = loadBackupConfig({});

    expect(config.enabled).toBe(true);
    expect(config.backupCron).toBe("0 2 * * *");
    expect(config.restoreTestCron).toBe("0 4 * * 0");
    expect(config.restoreTestEnabled).toBe(true);
    expect(config.retentionDays).toBe(30);
    expect(config.backupDir).toBe(path.resolve(process.cwd(), "backups"));
    expect(config.encryptionKey).toBeNull();
    expect(config.s3Bucket).toBeNull();
    expect(config.uploadToS3).toBe(false);
    expect(config.scratchDbPrefix).toBe("lumina_restore_test_");
    expect(config.maxHistoryEntries).toBe(500);
    expect(config.verifyTables).toEqual(["vaults", "sub_schedules", "beneficiaries"]);
    expect(config.pg.database).toBe("vesting_vault");
    expect(config.pg.user).toBe("postgres");
    expect(config.pg.host).toBe("localhost");
    expect(config.pg.port).toBe(5432);
  });

  test("overrides defaults from environment variables", () => {
    const config = loadBackupConfig({
      BACKUP_ENABLED: "false",
      BACKUP_DIR: tmpDir,
      BACKUP_CRON: "0 3 * * *",
      BACKUP_RESTORE_TEST_CRON: "0 5 * * 1",
      BACKUP_RESTORE_TEST_ENABLED: "false",
      BACKUP_RETENTION_DAYS: "14",
      BACKUP_ENCRYPTION_KEY: "0123456789abcdef",
      BACKUP_S3_BUCKET: "s3://lumina-backups/prod",
      BACKUP_S3_UPLOAD: "true",
      BACKUP_VERIFY_TABLES: "vaults,beneficiaries, invalid-table!",
      BACKUP_SCRATCH_DB_PREFIX: "restore_scratch_",
      BACKUP_HISTORY_LIMIT: "100",
      PG_DB: "lumina",
      PG_USER: "lumina_app",
      PG_HOST: "db.internal",
      PG_PORT: "5433",
      PG_PASSWORD: "secret",
    });

    expect(config.enabled).toBe(false);
    expect(config.backupDir).toBe(tmpDir);
    expect(config.backupCron).toBe("0 3 * * *");
    expect(config.restoreTestCron).toBe("0 5 * * 1");
    expect(config.restoreTestEnabled).toBe(false);
    expect(config.retentionDays).toBe(14);
    expect(config.encryptionKey).toBe("0123456789abcdef");
    expect(config.s3Bucket).toBe("s3://lumina-backups/prod");
    expect(config.uploadToS3).toBe(true);
    // Invalid identifiers are filtered out of the verify list.
    expect(config.verifyTables).toEqual(["vaults", "beneficiaries"]);
    expect(config.scratchDbPrefix).toBe("restore_scratch_");
    expect(config.maxHistoryEntries).toBe(100);
    expect(config.pg.database).toBe("lumina");
    expect(config.pg.user).toBe("lumina_app");
    expect(config.pg.host).toBe("db.internal");
    expect(config.pg.port).toBe(5433);
    expect(config.pg.password).toBe("secret");
  });

  test("falls back to DB_* variables for the postgres connection", () => {
    const config = loadBackupConfig({
      DB_NAME: "fallback_db",
      DB_USER: "fallback_user",
      DB_HOST: "fallback-host",
      DB_PORT: "6000",
      DB_PASSWORD: "pw",
    });

    expect(config.pg.database).toBe("fallback_db");
    expect(config.pg.user).toBe("fallback_user");
    expect(config.pg.host).toBe("fallback-host");
    expect(config.pg.port).toBe(6000);
    expect(config.pg.password).toBe("pw");
  });

  test("rejects an invalid backup cron expression", () => {
    expect(() => loadBackupConfig({ BACKUP_CRON: "not-a-cron" })).toThrow(
      /backupCron must be a 5-field cron expression/,
    );
  });

  test("rejects an invalid restore test cron expression", () => {
    expect(() => loadBackupConfig({ BACKUP_RESTORE_TEST_CRON: "0 2 * *" })).toThrow(
      /restoreTestCron must be a 5-field cron expression/,
    );
  });

  test("rejects invalid retention days", () => {
    expect(() => loadBackupConfig({ BACKUP_RETENTION_DAYS: "0" })).toThrow(
      /retentionDays must be an integer between 1 and 3650/,
    );
    expect(() => loadBackupConfig({ BACKUP_RETENTION_DAYS: "abc" })).toThrow(
      /retentionDays must be an integer between 1 and 3650/,
    );
  });

  test("rejects an invalid scratch database prefix", () => {
    expect(() => loadBackupConfig({ BACKUP_SCRATCH_DB_PREFIX: "bad-prefix!" })).toThrow(
      /scratchDbPrefix must be a valid PostgreSQL identifier prefix/,
    );
  });

  test("rejects a short encryption key", () => {
    expect(() => loadBackupConfig({ BACKUP_ENCRYPTION_KEY: "short" })).toThrow(
      /BACKUP_ENCRYPTION_KEY must be at least 16 characters/,
    );
  });

  test("rejects S3 upload without a valid bucket", () => {
    expect(() => loadBackupConfig({ BACKUP_S3_UPLOAD: "true", BACKUP_S3_BUCKET: "nope" })).toThrow(
      /s3Bucket must be an s3:\/\/ URI/,
    );
  });

  test("validateBackupConfig accepts a fully valid config", () => {
    const config = loadBackupConfig({
      BACKUP_ENCRYPTION_KEY: "0123456789abcdef",
      BACKUP_DIR: tmpDir,
    });
    expect(() => validateBackupConfig(config)).not.toThrow();
  });
});
