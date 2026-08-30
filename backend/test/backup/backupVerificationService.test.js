const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const {
  BackupVerificationService,
  BackupVerificationError,
} = require("../../src/backup/backupVerificationService");
const { BackupHistoryStore } = require("../../src/backup/backupHistoryStore");

const FAKE_DUMP = `--
-- PostgreSQL database dump
--

SET statement_timeout = 0;
SET lock_timeout = 0;

CREATE TABLE public.vaults (
    id integer NOT NULL,
    address character varying(255)
);

CREATE TABLE public.sub_schedules (
    id integer NOT NULL,
    vault_id integer
);

CREATE TABLE public.beneficiaries (
    id integer NOT NULL,
    address character varying(255)
);
`;

const sha256 = (input) => crypto.createHash("sha256").update(input).digest("hex");

/** execFile mock that mimics pg_dump, openssl, psql, and aws behaviour. */
function createExecFileMock({ failCommand } = {}) {
  return jest.fn(async (command, args) => {
    if (failCommand && command === failCommand) {
      const error = new Error(`${command} failed`);
      error.code = 1;
      error.stderr = "command error output";
      throw error;
    }
    if (command === "pg_dump") {
      const dumpPath = args[args.indexOf("-f") + 1];
      fs.writeFileSync(dumpPath, FAKE_DUMP);
    } else if (command === "openssl") {
      const inPath = args[args.indexOf("-in") + 1];
      const outPath = args[args.indexOf("-out") + 1];
      fs.copyFileSync(inPath, outPath);
    }
    return { stdout: "", stderr: "" };
  });
}

/** pg client factory that returns deterministic counts per database. */
function createPgClientFactory({ tableDelta = 0, rowDeltas = {} } = {}) {
  const tableCounts = { source: 12, restored: 12 + tableDelta };
  const rowCounts = {
    vaults: { source: 5, restored: 5 + (rowDeltas.vaults || 0) },
    sub_schedules: { source: 3, restored: 3 + (rowDeltas.sub_schedules || 0) },
    beneficiaries: { source: 8, restored: 8 + (rowDeltas.beneficiaries || 0) },
  };
  return (config, database) => {
    const isSource = database === config.pg.database;
    return {
      connect: jest.fn().mockResolvedValue(),
      end: jest.fn().mockResolvedValue(),
      query: jest.fn(async (sql) => {
        if (sql.includes("information_schema.tables")) {
          return { rows: [{ count: isSource ? tableCounts.source : tableCounts.restored }] };
        }
        const match = sql.match(/FROM "([^"]+)"/);
        if (match) {
          const table = match[1];
          const counts = rowCounts[table] || { source: 0, restored: 0 };
          return { rows: [{ count: isSource ? counts.source : counts.restored }] };
        }
        return { rows: [] };
      }),
    };
  };
}

function createMetrics() {
  return {
    recordAttempt: jest.fn(),
    recordFailure: jest.fn(),
    recordSuccess: jest.fn(),
    recordDuration: jest.fn(),
    recordArtifactSize: jest.fn(),
    recordRowDelta: jest.fn(),
  };
}

describe("BackupVerificationService", () => {
  let dir;
  let config;
  let service;
  let metrics;
  let execFileMock;
  let historyStore;

  const makeService = (options = {}) => {
    metrics = options.metrics || createMetrics();
    execFileMock = options.execFile || createExecFileMock();
    historyStore = options.historyStore || new BackupHistoryStore({ dir, maxEntries: 100 });
    service = new BackupVerificationService({
      config: options.config || config,
      metrics,
      execFile: execFileMock,
      createPgClient: options.createPgClient || createPgClientFactory(),
      historyStore,
      now: options.now || (() => new Date("2026-08-30T02:00:00Z")),
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    return service;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-backup-service-"));
    config = require("../../src/backup/backupConfig").loadBackupConfig({
      BACKUP_DIR: dir,
      BACKUP_ENCRYPTION_KEY: "test-encryption-key-123456",
      BACKUP_RETENTION_DAYS: "30",
      PG_DB: "lumina",
      PG_USER: "postgres",
      PG_HOST: "localhost",
      PG_PORT: "5432",
      PG_PASSWORD: "secret",
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("takeBackup", () => {
    test("produces an encrypted artifact, manifest, and metrics", async () => {
      service = makeService();
      const artifact = await service.takeBackup();

      expect(artifact.fileName).toMatch(
        /^backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_\d{3}\.sql\.gz\.enc$/,
      );
      expect(artifact.encrypted).toBe(true);
      expect(artifact.dumpSha256).toBe(sha256(FAKE_DUMP));
      expect(artifact.sizeBytes).toBeGreaterThan(0);
      expect(artifact.sourceDatabase).toBe("lumina");

      // Manifest written next to the artifact.
      const manifestPath = path.join(dir, `${artifact.name}.manifest.json`);
      expect(fs.existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      expect(manifest.dumpSha256).toBe(sha256(FAKE_DUMP));

      // Executed pg_dump and openssl.
      const commands = execFileMock.mock.calls.map((call) => call[0]);
      expect(commands).toContain("pg_dump");
      expect(commands).toContain("openssl");

      // Metrics recorded.
      expect(metrics.recordAttempt).toHaveBeenCalledWith("backup");
      expect(metrics.recordSuccess).toHaveBeenCalledWith("backup", expect.any(Number));
      expect(metrics.recordArtifactSize).toHaveBeenCalledWith(expect.any(Number));
    });

    test("skips encryption when no key is configured", async () => {
      const plainConfig = require("../../src/backup/backupConfig").loadBackupConfig({
        BACKUP_DIR: dir,
        PG_DB: "lumina",
        PG_USER: "postgres",
      });
      service = makeService({ config: plainConfig });

      const artifact = await service.takeBackup();

      expect(artifact.encrypted).toBe(false);
      expect(artifact.fileName).toMatch(/\.sql\.gz$/);
      const opensslCalls = execFileMock.mock.calls.filter((call) => call[0] === "openssl");
      expect(opensslCalls).toHaveLength(0);
    });

    test("uploads to S3 when configured", async () => {
      const s3Config = require("../../src/backup/backupConfig").loadBackupConfig({
        BACKUP_DIR: dir,
        BACKUP_ENCRYPTION_KEY: "test-encryption-key-123456",
        BACKUP_S3_BUCKET: "s3://lumina-backups/prod",
        BACKUP_S3_UPLOAD: "true",
      });
      service = makeService({ config: s3Config });

      const artifact = await service.takeBackup();

      expect(artifact.s3Uri).toBe(`s3://lumina-backups/prod/${artifact.fileName}`);
      const awsCalls = execFileMock.mock.calls.filter((call) => call[0] === "aws");
      expect(awsCalls).toHaveLength(1);
      expect(awsCalls[0][1]).toContain("s3://lumina-backups/prod/");
    });

    test("records a failure and throws when pg_dump fails", async () => {
      service = makeService({ execFile: createExecFileMock({ failCommand: "pg_dump" }) });

      await expect(service.takeBackup()).rejects.toBeInstanceOf(BackupVerificationError);
      expect(metrics.recordFailure).toHaveBeenCalledWith("backup", "command_failed");
    });
  });

  describe("verifyBackup", () => {
    test("passes on a valid artifact", async () => {
      service = makeService();
      const artifact = await service.takeBackup();

      const result = await service.verifyBackup(artifact);

      expect(result.ok).toBe(true);
      expect(result.checksumOk).toBe(true);
      expect(result.headerOk).toBe(true);
      expect(result.tableCount).toBe(3);
      expect(metrics.recordSuccess).toHaveBeenCalledWith("verify", expect.any(Number));
    });

    test("fails when the dump checksum does not match the manifest", async () => {
      service = makeService();
      const artifact = await service.takeBackup();
      artifact.dumpSha256 = "deadbeef";

      await expect(service.verifyBackup(artifact)).rejects.toMatchObject({
        reason: "checksum_mismatch",
      });
      expect(metrics.recordFailure).toHaveBeenCalledWith("verify", "checksum_mismatch");
    });

    test("passes with a null checksum when no manifest is available", async () => {
      service = makeService();
      const artifact = await service.takeBackup();
      artifact.dumpSha256 = null;

      const result = await service.verifyBackup(artifact);

      expect(result.ok).toBe(true);
      expect(result.checksumOk).toBeNull();
    });
  });

  describe("restoreTestBackup", () => {
    test("restores into a scratch database, compares counts, and drops it", async () => {
      service = makeService();
      const artifact = await service.takeBackup();

      const result = await service.restoreTestBackup(artifact);

      expect(result.ok).toBe(true);
      expect(result.tableCountSource).toBe(12);
      expect(result.tableCountRestored).toBe(12);
      expect(result.rowCounts).toHaveLength(3);
      for (const row of result.rowCounts) {
        expect(row.delta).toBe(0);
      }
      expect(result.restoredDatabase).toMatch(/^lumina_restore_test_/);

      // Scratch database created and dropped via psql.
      const psqlCommands = execFileMock.mock.calls
        .filter((call) => call[0] === "psql")
        .map((call) => call[1].join(" "));
      expect(psqlCommands.some((cmd) => cmd.includes("CREATE DATABASE"))).toBe(true);
      expect(psqlCommands.some((cmd) => cmd.includes("DROP DATABASE"))).toBe(true);

      expect(metrics.recordSuccess).toHaveBeenCalledWith("restore_test", expect.any(Number));
    });

    test("fails when a table row count differs from the live database", async () => {
      service = makeService({
        createPgClient: createPgClientFactory({ rowDeltas: { vaults: 2 } }),
      });
      const artifact = await service.takeBackup();

      const result = await service.restoreTestBackup(artifact);

      expect(result.ok).toBe(false);
      const vaultRow = result.rowCounts.find((r) => r.table === "vaults");
      expect(vaultRow.delta).toBe(-2); // delta = source - restored
      expect(metrics.recordFailure).toHaveBeenCalledWith("restore_test", "row_count_mismatch");
      expect(metrics.recordRowDelta).toHaveBeenCalledWith("vaults", -2);
    });

    test("fails when the table count differs from the live database", async () => {
      service = makeService({
        createPgClient: createPgClientFactory({ tableDelta: -1 }),
      });
      const artifact = await service.takeBackup();

      const result = await service.restoreTestBackup(artifact);

      expect(result.ok).toBe(false);
    });
  });

  describe("runFullVerification", () => {
    test("runs the full pipeline and appends to history", async () => {
      service = makeService();
      const report = await service.runFullVerification();

      expect(report.status).toBe("ok");
      expect(report.kind).toBe("full");
      expect(report.backup.name).toMatch(/^backup_/);
      expect(report.verification.ok).toBe(true);
      expect(report.restoreTest.ok).toBe(true);

      const history = historyStore.list();
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe("ok");
    });

    test("records a failed report when the backup fails", async () => {
      service = makeService({ execFile: createExecFileMock({ failCommand: "pg_dump" }) });

      const report = await service.runFullVerification();

      expect(report.status).toBe("failed");
      expect(report.error).toMatch(/pg_dump/);
      const history = historyStore.list();
      expect(history[0].status).toBe("failed");
    });
  });

  describe("verifyLatestBackup", () => {
    test("reports failure when no artifacts exist", async () => {
      service = makeService();
      const report = await service.verifyLatestBackup();

      expect(report.status).toBe("failed");
      expect(report.error).toMatch(/No backup artifacts found/);
      expect(metrics.recordFailure).toHaveBeenCalledWith("verify", "not_found");
    });

    test("verifies and restore-tests the newest artifact on disk", async () => {
      service = makeService();
      await service.takeBackup();

      const report = await service.verifyLatestBackup();

      expect(report.status).toBe("ok");
      expect(report.verification.tableCount).toBe(3);
      expect(report.restoreTest.ok).toBe(true);
    });
  });

  describe("retention cleanup", () => {
    test("removes artifacts older than the retention window", async () => {
      const retentionConfig = require("../../src/backup/backupConfig").loadBackupConfig({
        BACKUP_DIR: dir,
        BACKUP_ENCRYPTION_KEY: "test-encryption-key-123456",
        BACKUP_RETENTION_DAYS: "1",
      });
      service = makeService({ config: retentionConfig, now: () => new Date() });
      const oldArtifact = await service.takeBackup();

      // Age the artifact beyond the 1-day retention window.
      const oldTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      fs.utimesSync(oldArtifact.absolutePath, oldTime, oldTime);
      const manifestPath = path.join(dir, `${oldArtifact.name}.manifest.json`);
      if (fs.existsSync(manifestPath)) fs.utimesSync(manifestPath, oldTime, oldTime);

      await service.takeBackup();

      const remaining = service.listArtifacts();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].name).not.toBe(oldArtifact.name);
      // The old artifact and its manifest are both removed by retention.
      expect(fs.existsSync(oldArtifact.absolutePath)).toBe(false);
      expect(fs.existsSync(path.join(dir, `${oldArtifact.name}.manifest.json`))).toBe(false);
    });
  });

  describe("BackupHistoryStore", () => {
    test("lists newest entries first and prunes beyond the limit", () => {
      const store = new BackupHistoryStore({ dir, maxEntries: 3 });
      for (let i = 1; i <= 5; i += 1) store.append({ id: i });

      const list = store.list();
      expect(list.map((e) => e.id)).toEqual([5, 4, 3]);
      expect(store.latest().id).toBe(5);
    });

    test("skips corrupt lines without failing", () => {
      const store = new BackupHistoryStore({ dir, maxEntries: 10 });
      store.append({ id: 1 });
      fs.appendFileSync(store.filePath, "{not-json}\n");
      store.append({ id: 2 });

      const list = store.list();
      expect(list.map((e) => e.id)).toEqual([2, 1]);
    });
  });
});
