const cron = require("node-cron");
const { loadBackupConfig } = require("../backup/backupConfig");
const { BackupVerificationService } = require("../backup/backupVerificationService");

/**
 * Scheduled Database Backup Verification with Restore Testing (Issue #101).
 *
 * Two independent schedules are managed by this job:
 *   - BACKUP_CRON (default 0 2 * * *)          — daily backup + integrity check
 *   - BACKUP_RESTORE_TEST_CRON (default 0 4 * * 0) — weekly restore test of the
 *     latest verified backup into an isolated scratch database
 *
 * A single node process may run the job; node-cron schedules are process-local,
 * so exactly one backend instance should start it (mirrors the other scheduled
 * jobs in this repository).
 */
class BackupVerificationJob {
  constructor(options = {}) {
    this.config = options.config || loadBackupConfig();
    this.service = options.service || new BackupVerificationService({ config: this.config });
    this.cronJobs = [];
    this.lastRun = null;
  }

  start() {
    if (!this.config.enabled) {
      console.log("[BackupVerification] Job disabled via BACKUP_ENABLED=false. Skipping schedule.");
      return;
    }
    console.log(
      `[BackupVerification] Scheduling daily backup+verify at "${this.config.backupCron}"`,
    );
    this.cronJobs.push(cron.schedule(this.config.backupCron, () => this.runScheduled("backup")));

    if (this.config.restoreTestEnabled) {
      console.log(
        `[BackupVerification] Scheduling weekly restore test at "${this.config.restoreTestCron}"`,
      );
      this.cronJobs.push(
        cron.schedule(this.config.restoreTestCron, () => this.runScheduled("restore-test")),
      );
    } else {
      console.log(
        "[BackupVerification] Restore testing disabled via BACKUP_RESTORE_TEST_ENABLED=false.",
      );
    }
  }

  stop() {
    for (const job of this.cronJobs) {
      if (job && typeof job.stop === "function") job.stop();
    }
    this.cronJobs = [];
  }

  async runScheduled(mode) {
    this.lastRun = new Date().toISOString();
    try {
      if (mode === "restore-test") {
        return await this.service.verifyLatestBackup();
      }
      return await this.service.runFullVerification();
    } catch (error) {
      console.error(`[BackupVerification] Scheduled ${mode} run failed:`, error.message);
      return { status: "failed", error: error.message };
    }
  }

  /** Manual trigger: full pipeline (backup + verify + restore test). */
  async runFullVerification() {
    return this.service.runFullVerification();
  }

  /** Manual trigger: restore test against the latest backup artifact. */
  async runRestoreTest() {
    return this.service.verifyLatestBackup();
  }

  getStatus() {
    return {
      ...this.service.getStatus(),
      lastScheduledRun: this.lastRun,
    };
  }
}

module.exports = { BackupVerificationJob };
