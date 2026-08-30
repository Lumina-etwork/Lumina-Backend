const express = require("express");
const { BackupVerificationJob } = require("../jobs/backupVerificationJob");

const router = express.Router();

let jobInstance = null;
function getJob() {
  if (!jobInstance) jobInstance = new BackupVerificationJob();
  return jobInstance;
}

/**
 * Scheduled Database Backup Verification (Issue #101) — admin routes.
 *
 * GET  /api/admin/backups/status   — configuration and latest report
 * GET  /api/admin/backups/history  — recent verification history
 * POST /api/admin/backups/run      — manual full verification (backup+verify+restore test)
 * POST /api/admin/backups/restore-test — manual restore test of the latest backup
 */
router.get("/status", (req, res) => {
  try {
    res.json({ success: true, data: getJob().getStatus() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/history", (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const history = getJob().service.historyStore.list(limit);
    res.json({ success: true, data: history });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/run", async (req, res) => {
  try {
    const report = await getJob().runFullVerification();
    res
      .status(report.status === "ok" ? 200 : 500)
      .json({ success: report.status === "ok", data: report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/restore-test", async (req, res) => {
  try {
    const report = await getJob().runRestoreTest();
    res
      .status(report.status === "ok" ? 200 : 500)
      .json({ success: report.status === "ok", data: report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
