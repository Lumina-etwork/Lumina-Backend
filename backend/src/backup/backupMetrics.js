const client = require("prom-client");

/**
 * Prometheus metrics for the Scheduled Database Backup Verification subsystem.
 *
 * Metrics are registered on the shared backend registry so they are exposed on
 * the existing /metrics endpoint. When the shared metrics service is not
 * available (for example during isolated unit tests) a private registry is
 * used instead, keeping the subsystem self-contained.
 */

let register = null;
try {
  register = require("../services/metricsService").register || null;
} catch {
  register = null;
}

const registry = register || new client.Registry();

const METRIC_OPTIONS = { registers: [registry] };

const backupAttemptsTotal = new client.Counter({
  name: "backup_attempts_total",
  help: "Total scheduled database backup verification attempts",
  labelNames: ["operation"], // backup | verify | restore_test
  ...METRIC_OPTIONS,
});

const backupFailuresTotal = new client.Counter({
  name: "backup_failures_total",
  help: "Total failed scheduled database backup verification attempts",
  labelNames: ["operation", "reason"],
  ...METRIC_OPTIONS,
});

const backupDurationSeconds = new client.Histogram({
  name: "backup_duration_seconds",
  help: "Duration of scheduled database backup verification operations",
  labelNames: ["operation"],
  buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600],
  ...METRIC_OPTIONS,
});

const backupSizeBytes = new client.Gauge({
  name: "backup_size_bytes",
  help: "Size in bytes of the latest encrypted backup artifact",
  ...METRIC_OPTIONS,
});

const backupVerificationStatus = new client.Gauge({
  name: "backup_verification_status",
  help: "Status of the latest backup verification (1=ok, 0=failed)",
  labelNames: ["operation"],
  ...METRIC_OPTIONS,
});

const backupLastSuccessTimestamp = new client.Gauge({
  name: "backup_last_success_timestamp",
  help: "Unix timestamp of the last successful backup verification operation",
  labelNames: ["operation"],
  ...METRIC_OPTIONS,
});

const backupRestoreTestRowDelta = new client.Gauge({
  name: "backup_restore_test_row_delta",
  help: "Row count delta (source - restored) per table from the latest restore test",
  labelNames: ["table"],
  ...METRIC_OPTIONS,
});

function recordAttempt(operation) {
  backupAttemptsTotal.inc({ operation });
}

function recordFailure(operation, reason) {
  backupFailuresTotal.inc({ operation, reason });
  backupVerificationStatus.set({ operation }, 0);
}

function recordSuccess(operation, at = Date.now()) {
  backupVerificationStatus.set({ operation }, 1);
  backupLastSuccessTimestamp.set({ operation }, Math.floor(at / 1000));
}

function recordDuration(operation, durationMs) {
  backupDurationSeconds.observe({ operation }, durationMs / 1000);
}

function recordArtifactSize(sizeBytes) {
  if (Number.isFinite(sizeBytes) && sizeBytes >= 0) {
    backupSizeBytes.set(sizeBytes);
  }
}

function recordRowDelta(table, delta) {
  if (delta === null || delta === undefined) {
    backupRestoreTestRowDelta.set({ table }, 0);
    return;
  }
  backupRestoreTestRowDelta.set({ table }, delta);
}

module.exports = {
  registry,
  backupAttemptsTotal,
  backupFailuresTotal,
  backupDurationSeconds,
  backupSizeBytes,
  backupVerificationStatus,
  backupLastSuccessTimestamp,
  backupRestoreTestRowDelta,
  recordAttempt,
  recordFailure,
  recordSuccess,
  recordDuration,
  recordArtifactSize,
  recordRowDelta,
};
