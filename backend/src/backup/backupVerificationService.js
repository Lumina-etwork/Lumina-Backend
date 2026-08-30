const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { Client } = require("pg");

const { loadBackupConfig } = require("./backupConfig");
const backupMetrics = require("./backupMetrics");
const { BackupHistoryStore } = require("./backupHistoryStore");

const execFileAsync = promisify(execFile);

const ARTIFACT_PATTERN = /^backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_\d{3}\.sql\.gz(\.enc)?$/;
const TABLE_IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

class BackupVerificationError extends Error {
  constructor(message, { reason = "unknown", cause } = {}) {
    super(message);
    this.name = "BackupVerificationError";
    this.reason = reason;
    if (cause) this.cause = cause;
  }
}

/** Compute the SHA-256 digest of a file without loading it fully into memory. */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function defaultCreatePgClient(config, database) {
  return new Client({
    host: config.pg.host,
    port: config.pg.port,
    user: config.pg.user,
    password: config.pg.password,
    database,
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined,
    connectionTimeoutMillis: 10000,
    query_timeout: 30000,
  });
}

/** pg_dump plain-format dumps start with a recognizable header. */
function hasPostgresDumpHeader(content) {
  return /PostgreSQL database dump/i.test(content.slice(0, 4096));
}

function countCreateTableStatements(content) {
  const matches = content.match(/^CREATE TABLE\s+/gim);
  return matches ? matches.length : 0;
}

/**
 * Scheduled Database Backup Verification with Restore Testing.
 *
 * Pipeline per cycle:
 *   1. takeBackup   — pg_dump → gzip → AES-256 encrypt → optional S3 copy
 *   2. verifyBackup — decrypt/decompress, checksum + header + table sanity
 *   3. restoreTest  — restore into an isolated scratch database, compare table
 *                     and row counts against the live database, then drop it
 *
 * Every step emits Prometheus metrics and appends to the local history store.
 */
class BackupVerificationService {
  constructor(options = {}) {
    this.config = options.config || loadBackupConfig();
    this.metrics = options.metrics || backupMetrics;
    this.execFile = options.execFile || execFileAsync;
    this.createPgClient = options.createPgClient || defaultCreatePgClient;
    this.historyStore =
      options.historyStore ||
      new BackupHistoryStore({
        dir: this.config.backupDir,
        maxEntries: this.config.maxHistoryEntries,
      });
    this.now = options.now || (() => new Date());
    this.logger = options.logger || console;
  }

  // -------------------------------------------------------------------------
  // Orchestration
  // -------------------------------------------------------------------------

  /** Run the complete pipeline: backup, verify, restore test. */
  async runFullVerification() {
    const startedAt = this.now();
    let report;
    try {
      const backup = await this.takeBackup();
      const verification = await this.verifyBackup(backup);
      let restoreTest = null;
      if (this.config.restoreTestEnabled) {
        restoreTest = await this.restoreTestBackup(backup);
      }
      const ok = verification.ok && (!restoreTest || restoreTest.ok);
      report = {
        kind: "full",
        status: ok ? "ok" : "failed",
        startedAt: startedAt.toISOString(),
        finishedAt: this.now().toISOString(),
        backup: {
          name: backup.name,
          fileName: backup.fileName,
          sizeBytes: backup.sizeBytes,
          sourceDatabase: backup.sourceDatabase,
          status: "ok",
        },
        verification: {
          ok: verification.ok,
          checksumOk: verification.checksumOk,
          headerOk: verification.headerOk,
          tableCount: verification.tableCount,
          durationMs: verification.durationMs,
        },
        restoreTest: restoreTest
          ? {
              ok: restoreTest.ok,
              tableCountSource: restoreTest.tableCountSource,
              tableCountRestored: restoreTest.tableCountRestored,
              rowCounts: restoreTest.rowCounts,
              restoredDatabase: restoreTest.restoredDatabase,
              durationMs: restoreTest.durationMs,
            }
          : null,
      };
    } catch (error) {
      report = {
        kind: "full",
        status: "failed",
        startedAt: startedAt.toISOString(),
        finishedAt: this.now().toISOString(),
        error: error.message,
      };
    }
    this.historyStore.append(report);
    return report;
  }

  /** Verify and restore-test the newest backup artifact already on disk. */
  async verifyLatestBackup() {
    const startedAt = this.now();
    let report;
    try {
      const artifact = this.latestArtifact();
      if (!artifact) {
        throw new BackupVerificationError("No backup artifacts found on disk", {
          reason: "not_found",
        });
      }
      const verification = await this.verifyBackup(artifact);
      let restoreTest = null;
      if (this.config.restoreTestEnabled) {
        restoreTest = await this.restoreTestBackup(artifact);
      }
      const ok = verification.ok && (!restoreTest || restoreTest.ok);
      report = {
        kind: "verify_latest",
        status: ok ? "ok" : "failed",
        startedAt: startedAt.toISOString(),
        finishedAt: this.now().toISOString(),
        artifact: {
          name: artifact.name,
          fileName: artifact.fileName,
          sizeBytes: artifact.sizeBytes,
        },
        verification: {
          ok: verification.ok,
          checksumOk: verification.checksumOk,
          headerOk: verification.headerOk,
          tableCount: verification.tableCount,
          durationMs: verification.durationMs,
        },
        restoreTest: restoreTest
          ? {
              ok: restoreTest.ok,
              tableCountSource: restoreTest.tableCountSource,
              tableCountRestored: restoreTest.tableCountRestored,
              rowCounts: restoreTest.rowCounts,
              restoredDatabase: restoreTest.restoredDatabase,
              durationMs: restoreTest.durationMs,
            }
          : null,
      };
    } catch (error) {
      this.metrics.recordFailure("verify", error.reason || "unknown");
      report = {
        kind: "verify_latest",
        status: "failed",
        startedAt: startedAt.toISOString(),
        finishedAt: this.now().toISOString(),
        error: error.message,
      };
    }
    this.historyStore.append(report);
    return report;
  }

  // -------------------------------------------------------------------------
  // Step 1 — backup
  // -------------------------------------------------------------------------

  /** Take a new backup: pg_dump → gzip → encrypt → optional S3 upload. */
  async takeBackup() {
    const startedAt = this.now();
    this.metrics.recordAttempt("backup");
    const timestamp = this.formatTimestamp(startedAt);
    const name = `backup_${timestamp}`;
    const dumpPath = path.join(this.config.backupDir, `${name}.sql`);
    const archivePath = `${dumpPath}.gz`;
    const encryptedPath = `${archivePath}.enc`;
    const finalPath = this.config.encryptionKey ? encryptedPath : archivePath;

    try {
      fs.mkdirSync(this.config.backupDir, { recursive: true });

      this.logger.info(`[BackupVerification] pg_dump ${this.config.pg.database} -> ${dumpPath}`);
      await this.runCommand("pg_dump", [
        "-h",
        this.config.pg.host,
        "-p",
        String(this.config.pg.port),
        "-U",
        this.config.pg.user,
        "--format=plain",
        "--no-owner",
        "--no-privileges",
        "--no-comments",
        "-f",
        dumpPath,
        this.config.pg.database,
      ]);

      const dumpSha256 = await sha256File(dumpPath);
      const dumpSizeBytes = fs.statSync(dumpPath).size;

      // Compress with Node zlib (no external gzip binary required).
      fs.writeFileSync(archivePath, zlib.gzipSync(fs.readFileSync(dumpPath), { level: 9 }));
      fs.unlinkSync(dumpPath);

      if (this.config.encryptionKey) {
        this.logger.info("[BackupVerification] Encrypting backup artifact");
        await this.runCommand(
          "openssl",
          [
            "enc",
            "-aes-256-cbc",
            "-pbkdf2",
            "-iter",
            "100000",
            "-pass",
            "env:BACKUP_ENCRYPTION_KEY",
            "-in",
            archivePath,
            "-out",
            encryptedPath,
          ],
          { env: { ...process.env, BACKUP_ENCRYPTION_KEY: this.config.encryptionKey } },
        );
        fs.unlinkSync(archivePath);
      }

      const finalSha256 = await sha256File(finalPath);
      const sizeBytes = fs.statSync(finalPath).size;

      const artifact = {
        name,
        fileName: path.basename(finalPath),
        absolutePath: finalPath,
        createdAt: startedAt.toISOString(),
        encrypted: Boolean(this.config.encryptionKey),
        dumpSha256,
        encryptedSha256: finalSha256,
        dumpSizeBytes,
        sizeBytes,
        sourceDatabase: this.config.pg.database,
      };

      this.writeManifest(artifact);

      if (this.config.uploadToS3 && this.config.s3Bucket) {
        this.logger.info(`[BackupVerification] Uploading to ${this.config.s3Bucket}`);
        await this.runCommand("aws", [
          "s3",
          "cp",
          finalPath,
          `${this.config.s3Bucket.replace(/\/$/, "")}/`,
          "--sse",
          "aws:kms",
        ]);
        artifact.s3Uri = `${this.config.s3Bucket.replace(/\/$/, "")}/${artifact.fileName}`;
      }

      this.cleanupOldBackups();

      this.metrics.recordArtifactSize(sizeBytes);
      this.metrics.recordSuccess("backup", startedAt.getTime());
      this.metrics.recordDuration("backup", this.now().getTime() - startedAt.getTime());

      this.logger.info(
        `[BackupVerification] Backup complete: ${artifact.fileName} (${sizeBytes} bytes)`,
      );
      return artifact;
    } catch (error) {
      this.metrics.recordFailure("backup", error.reason || "command_failed");
      this.metrics.recordDuration("backup", this.now().getTime() - startedAt.getTime());
      throw new BackupVerificationError(`Backup failed: ${error.message}`, {
        reason: error.reason || "command_failed",
        cause: error,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 2 — integrity verification
  // -------------------------------------------------------------------------

  /**
   * Verify a backup artifact: decryption + decompression must succeed, the
   * dump checksum must match the manifest, the pg_dump header must be present,
   * and the dump must contain CREATE TABLE statements.
   */
  async verifyBackup(artifact) {
    const startedAt = this.now();
    this.metrics.recordAttempt("verify");
    let materialized = null;
    try {
      materialized = await this.materializePlainSql(artifact);
      const { content } = materialized;

      const checksumOk = artifact.dumpSha256 ? materialized.checksum === artifact.dumpSha256 : null;
      if (checksumOk === false) {
        throw new BackupVerificationError(
          `Checksum mismatch for ${artifact.fileName}: expected ${artifact.dumpSha256}, got ${materialized.checksum}`,
          { reason: "checksum_mismatch" },
        );
      }

      const headerOk = hasPostgresDumpHeader(content);
      const tableCount = countCreateTableStatements(content);
      if (!headerOk || tableCount === 0) {
        throw new BackupVerificationError(
          `Dump content check failed for ${artifact.fileName}: headerOk=${headerOk}, tableCount=${tableCount}`,
          { reason: "dump_content_invalid" },
        );
      }

      const durationMs = this.now().getTime() - startedAt.getTime();
      this.metrics.recordSuccess("verify", startedAt.getTime());
      this.metrics.recordDuration("verify", durationMs);

      return {
        ok: true,
        checksumOk,
        headerOk,
        tableCount,
        durationMs,
        verifiedAt: this.now().toISOString(),
      };
    } catch (error) {
      this.metrics.recordFailure("verify", error.reason || "command_failed");
      this.metrics.recordDuration("verify", this.now().getTime() - startedAt.getTime());
      throw new BackupVerificationError(`Verification failed: ${error.message}`, {
        reason: error.reason || "command_failed",
        cause: error,
      });
    } finally {
      if (materialized && materialized.tmpDir) {
        fs.rmSync(materialized.tmpDir, { recursive: true, force: true });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 3 — restore testing
  // -------------------------------------------------------------------------

  /**
   * Restore a backup into an isolated scratch database, compare table and row
   * counts against the live database, then drop the scratch database.
   */
  async restoreTestBackup(artifact) {
    const startedAt = this.now();
    this.metrics.recordAttempt("restore_test");
    const scratchDb = `${this.config.scratchDbPrefix}${startedAt.getTime()}`;
    const { pg } = this.config;
    let materialized = null;
    let sourceClient = null;
    let restoredClient = null;

    const dropScratchDatabase = async () => {
      try {
        const dropSql = [
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${scratchDb}' AND pid <> pg_backend_pid();`,
          `DROP DATABASE IF EXISTS "${scratchDb}";`,
        ].join("\n");
        await this.runCommand("psql", [
          "-h",
          pg.host,
          "-p",
          String(pg.port),
          "-U",
          pg.user,
          "-d",
          this.config.maintenanceDatabase,
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          dropSql,
        ]);
        this.logger.info(`[BackupVerification] Scratch database ${scratchDb} dropped`);
      } catch (error) {
        this.logger.error(
          `[BackupVerification] Failed to drop scratch database ${scratchDb}: ${error.message}`,
        );
      }
    };

    try {
      materialized = await this.materializePlainSql(artifact);

      this.logger.info(`[BackupVerification] Creating scratch database ${scratchDb}`);
      await this.runCommand("psql", [
        "-h",
        pg.host,
        "-p",
        String(pg.port),
        "-U",
        pg.user,
        "-d",
        this.config.maintenanceDatabase,
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `CREATE DATABASE "${scratchDb}";`,
      ]);

      this.logger.info(`[BackupVerification] Restoring ${artifact.fileName} into ${scratchDb}`);
      await this.runCommand("psql", [
        "-h",
        pg.host,
        "-p",
        String(pg.port),
        "-U",
        pg.user,
        "-d",
        scratchDb,
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        materialized.sqlPath,
      ]);

      sourceClient = this.createPgClient(this.config, pg.database);
      restoredClient = this.createPgClient(this.config, scratchDb);
      await sourceClient.connect();
      await restoredClient.connect();

      const tableCountSource = await this.countPublicTables(sourceClient);
      const tableCountRestored = await this.countPublicTables(restoredClient);

      const rowCounts = [];
      let hasMismatch = false;
      for (const table of this.config.verifyTables) {
        const source = await this.countRows(sourceClient, table);
        const restored = await this.countRows(restoredClient, table);
        const delta = source === null || restored === null ? null : source - restored;
        if (delta !== null && delta !== 0) hasMismatch = true;
        rowCounts.push({ table, source, restored, delta });
        this.metrics.recordRowDelta(table, delta);
      }

      const ok = tableCountRestored === tableCountSource && !hasMismatch;
      const durationMs = this.now().getTime() - startedAt.getTime();

      if (ok) {
        this.metrics.recordSuccess("restore_test", startedAt.getTime());
        this.logger.info("[BackupVerification] Restore test passed");
      } else {
        this.metrics.recordFailure("restore_test", "row_count_mismatch");
        this.logger.error(
          `[BackupVerification] Restore test failed: sourceTables=${tableCountSource}, restoredTables=${tableCountRestored}, mismatches=${JSON.stringify(rowCounts)}`,
        );
      }
      this.metrics.recordDuration("restore_test", durationMs);

      return {
        ok,
        tableCountSource,
        tableCountRestored,
        rowCounts,
        restoredDatabase: scratchDb,
        durationMs,
        restoredAt: this.now().toISOString(),
      };
    } catch (error) {
      this.metrics.recordFailure("restore_test", error.reason || "restore_failed");
      this.metrics.recordDuration("restore_test", this.now().getTime() - startedAt.getTime());
      throw new BackupVerificationError(`Restore test failed: ${error.message}`, {
        reason: error.reason || "restore_failed",
        cause: error,
      });
    } finally {
      if (restoredClient) await this.safeEnd(restoredClient);
      if (sourceClient) await this.safeEnd(sourceClient);
      if (materialized && materialized.tmpDir) {
        fs.rmSync(materialized.tmpDir, { recursive: true, force: true });
      }
      await dropScratchDatabase();
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Decrypt (if needed) and decompress a backup artifact into a temporary
   * plain-text SQL file, returning its path, content, and SHA-256 checksum.
   */
  async materializePlainSql(artifact) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-backup-"));
    const base = path.basename(artifact.absolutePath || artifact.fileName);
    const plainBase = base.replace(/\.enc$/, "").replace(/\.gz$/, "");
    const gzPath = path.join(tmpDir, base.replace(/\.enc$/, ""));
    const sqlPath = path.join(tmpDir, plainBase);

    let currentPath = artifact.absolutePath;
    if (!currentPath) {
      currentPath = path.join(this.config.backupDir, artifact.fileName);
    }

    if (!fs.existsSync(currentPath)) {
      throw new BackupVerificationError(`Artifact not found: ${currentPath}`, {
        reason: "not_found",
      });
    }

    if (base.endsWith(".enc")) {
      await this.runCommand(
        "openssl",
        [
          "enc",
          "-d",
          "-aes-256-cbc",
          "-pbkdf2",
          "-iter",
          "100000",
          "-pass",
          "env:BACKUP_ENCRYPTION_KEY",
          "-in",
          currentPath,
          "-out",
          gzPath,
        ],
        { env: { ...process.env, BACKUP_ENCRYPTION_KEY: this.config.encryptionKey } },
      );
      currentPath = gzPath;
    }

    if (currentPath.endsWith(".gz")) {
      const content = zlib.gunzipSync(fs.readFileSync(currentPath));
      fs.writeFileSync(sqlPath, content);
      currentPath = sqlPath;
    }

    const checksum = await sha256File(currentPath);
    const content = fs.readFileSync(currentPath, "utf8");
    return { sqlPath: currentPath, tmpDir, checksum, content };
  }

  async countPublicTables(client) {
    const result = await client.query(
      "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public';",
    );
    return Number(result.rows[0].count);
  }

  async countRows(client, table) {
    if (!TABLE_IDENTIFIER_PATTERN.test(table)) return null;
    try {
      const result = await client.query(`SELECT count(*)::int AS count FROM "${table}";`);
      return Number(result.rows[0].count);
    } catch (error) {
      // Table may not exist in the restored schema; treat as unknown rather
      // than aborting the whole comparison.
      this.logger.warn(
        `[BackupVerification] Could not count rows for table "${table}": ${error.message}`,
      );
      return null;
    }
  }

  async runCommand(command, args, options = {}) {
    try {
      const env = { ...process.env, PGPASSWORD: this.config.pg.password, ...(options.env || {}) };
      return await this.execFile(command, args, { ...options, env, maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      const detail = error.stderr ? `: ${String(error.stderr).slice(0, 500)}` : "";
      const wrapped = new BackupVerificationError(`Command "${command}" failed${detail}`, {
        reason: "command_failed",
        cause: error,
      });
      wrapped.exitCode = error.code;
      throw wrapped;
    }
  }

  writeManifest(artifact) {
    const manifestPath = path.join(this.config.backupDir, `${artifact.name}.manifest.json`);
    fs.writeFileSync(manifestPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    artifact.manifestPath = manifestPath;
  }

  readManifest(name) {
    const manifestPath = path.join(this.config.backupDir, `${name}.manifest.json`);
    if (!fs.existsSync(manifestPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      return null;
    }
  }

  listArtifacts() {
    if (!fs.existsSync(this.config.backupDir)) return [];
    return fs
      .readdirSync(this.config.backupDir)
      .filter((file) => ARTIFACT_PATTERN.test(file))
      .map((fileName) => {
        const name = fileName.replace(/\.sql\.gz(\.enc)?$/, "");
        const stat = fs.statSync(path.join(this.config.backupDir, fileName));
        const manifest = this.readManifest(name) || {};
        return {
          name,
          fileName,
          absolutePath: path.join(this.config.backupDir, fileName),
          createdAt: stat.mtime.toISOString(),
          sizeBytes: stat.size,
          encrypted: fileName.endsWith(".enc"),
          dumpSha256: manifest.dumpSha256 || null,
          encryptedSha256: manifest.encryptedSha256 || null,
          sourceDatabase: manifest.sourceDatabase || null,
        };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  latestArtifact() {
    return this.listArtifacts()[0] || null;
  }

  /** Remove local artifacts older than the retention window. */
  cleanupOldBackups() {
    const cutoffMs = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const artifact of this.listArtifacts()) {
      const ageMs = new Date(artifact.createdAt).getTime();
      if (ageMs < cutoffMs) {
        const artifactFileName = `${artifact.name}.sql.gz${artifact.encrypted ? ".enc" : ""}`;
        const filesToRemove = [artifactFileName, `${artifact.name}.manifest.json`];
        for (const fileName of filesToRemove) {
          const filePath = path.join(this.config.backupDir, fileName);
          try {
            fs.unlinkSync(filePath);
            removed += 1;
          } catch {
            // Already gone or manifest-only entry.
          }
        }
      }
    }
    if (removed > 0) {
      this.logger.info(`[BackupVerification] Retention cleanup removed ${removed} old file(s)`);
    }
  }

  async safeEnd(client) {
    try {
      await client.end();
    } catch {
      // Best-effort cleanup.
    }
  }

  formatTimestamp(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
      `_${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}` +
      `_${String(date.getUTCMilliseconds()).padStart(3, "0")}`
    );
  }

  getStatus() {
    return {
      enabled: this.config.enabled,
      backupCron: this.config.backupCron,
      restoreTestCron: this.config.restoreTestCron,
      restoreTestEnabled: this.config.restoreTestEnabled,
      backupDir: this.config.backupDir,
      retentionDays: this.config.retentionDays,
      s3Bucket: this.config.s3Bucket,
      verifyTables: this.config.verifyTables,
      latestArtifact: this.latestArtifact()
        ? {
            name: this.latestArtifact().name,
            fileName: this.latestArtifact().fileName,
            sizeBytes: this.latestArtifact().sizeBytes,
          }
        : null,
      latestReport: this.historyStore.latest(),
    };
  }
}

module.exports = { BackupVerificationService, BackupVerificationError };
