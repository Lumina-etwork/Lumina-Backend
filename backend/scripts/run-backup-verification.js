#!/usr/bin/env node
/**
 * Manual CLI for the Scheduled Database Backup Verification subsystem.
 *
 * Usage:
 *   node scripts/run-backup-verification.js            # full: backup + verify + restore test
 *   node scripts/run-backup-verification.js --restore-test  # restore-test the latest backup
 *   node scripts/run-backup-verification.js --backup-only   # backup + integrity verify only
 *
 * Exit code 0 on success, 1 on failure — suitable for cron and CI hooks.
 */
const dotenv = require("dotenv");
dotenv.config();

const { BackupVerificationJob } = require("../src/jobs/backupVerificationJob");

async function main() {
  const args = process.argv.slice(2);
  const job = new BackupVerificationJob();

  let report;
  if (args.includes("--restore-test")) {
    console.log("[BackupVerification] Running restore test against the latest backup ...");
    report = await job.runRestoreTest();
  } else if (args.includes("--backup-only")) {
    console.log("[BackupVerification] Running backup + integrity verification ...");
    const service = job.service;
    const original = service.config.restoreTestEnabled;
    service.config.restoreTestEnabled = false;
    try {
      report = await service.runFullVerification();
    } finally {
      service.config.restoreTestEnabled = original;
    }
  } else {
    console.log("[BackupVerification] Running full backup verification cycle ...");
    report = await job.runFullVerification();
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report && report.status === "ok" ? 0 : 1);
}

main().catch((error) => {
  console.error("[BackupVerification] Fatal error:", error);
  process.exit(1);
});
