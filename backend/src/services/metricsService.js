const client = require('prom-client');

// Create a Registry which registers the metrics
const register = new client.Registry();

// Add a default label which is added to all metrics
register.setDefaultLabels({
  app: 'vesting-vault-backend'
});

// Enable the collection of default metrics
client.collectDefaultMetrics({ register });

// Custom metrics
const apiResponseTime = new client.Histogram({
  name: 'api_response_time_seconds',
  help: 'Response time of API endpoints in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 0.7, 1, 3, 5, 10]
});

const activeDbConnections = new client.Gauge({
  name: 'active_db_connections',
  help: 'Total number of active database connections'
});

const totalIndexedBlocks = new client.Gauge({
  name: 'total_indexed_ledger_blocks',
  help: 'Total number of ledger blocks indexed'
});

const tenantRateLimitDecisions = new client.Counter({
  name: 'tenant_rate_limit_decisions_total',
  help: 'Per-tenant token bucket rate limit decisions',
  labelNames: ['tenant_id', 'decision']
});

const secretRotationAttempts = new client.Counter({
  name: 'secret_rotation_attempts_total',
  help: 'Total secret rotation attempts',
  labelNames: ['secret_type', 'provider']
});

const secretRotationDuration = new client.Histogram({
  name: 'secret_rotation_duration_seconds',
  help: 'Secret rotation duration in seconds',
  labelNames: ['secret_type', 'provider']
});

const secretRotationStatus = new client.Gauge({
  name: 'secret_rotation_status',
  help: 'Status of latest rotation (1=success, 0=failure)',
  labelNames: ['secret_type', 'provider']
});

const secretRotationFailures = new client.Counter({
  name: 'secret_rotation_failures_total',
  help: 'Total secret rotation failures',
  labelNames: ['secret_type', 'provider']
});

// Dead Letter Queue metrics (Issue #104)
const dlqDepth = new client.Gauge({
  name: 'dlq_depth',
  help: 'Current number of messages in the dead letter queue',
  labelNames: ['source_queue']
});

const dlqEnqueueTotal = new client.Counter({
  name: 'dlq_enqueue_total',
  help: 'Total number of messages enqueued to the dead letter queue',
  labelNames: ['source_queue', 'job_name', 'reason']
});

const dlqRetryTotal = new client.Counter({
  name: 'dlq_retry_total',
  help: 'Total number of dead letter queue messages retried',
  labelNames: ['source_queue', 'job_name']
});

register.registerMetric(apiResponseTime);
register.registerMetric(activeDbConnections);
register.registerMetric(totalIndexedBlocks);
register.registerMetric(tenantRateLimitDecisions);
register.registerMetric(secretRotationAttempts);
register.registerMetric(secretRotationDuration);
register.registerMetric(secretRotationStatus);
register.registerMetric(secretRotationFailures);
register.registerMetric(dlqDepth);
register.registerMetric(dlqEnqueueTotal);
register.registerMetric(dlqRetryTotal);

/**
 * Record a message being enqueued to the DLQ.
 * @param {string} sourceQueue - The queue name the job originated from
 * @param {string} jobName - The job type/name
 * @param {string} reason - Reason for DLQ (e.g. 'exhausted_retries')
 */
function recordDlqMessage(sourceQueue, jobName, reason) {
  dlqEnqueueTotal.inc({ source_queue: sourceQueue, job_name: jobName, reason });
  dlqDepth.inc({ source_queue: sourceQueue });
}

/**
 * Record a DLQ capture failure (error while trying to move a job to DLQ).
 * @param {string} sourceQueue
 * @param {string} reason
 */
function recordDlqFailure(sourceQueue, reason) {
  // Increment a dedicated label on the enqueue counter to track capture errors
  dlqEnqueueTotal.inc({ source_queue: sourceQueue, job_name: 'unknown', reason });
}

/**
 * Record a DLQ message being retried.
 * @param {string} sourceQueue
 * @param {string} jobName
 */
function recordDlqRetry(sourceQueue, jobName) {
  dlqRetryTotal.inc({ source_queue: sourceQueue, job_name: jobName });
  dlqDepth.dec({ source_queue: sourceQueue });
}

module.exports = {
  register,
  apiResponseTime,
  activeDbConnections,
  totalIndexedBlocks,
  tenantRateLimitDecisions,
  secretRotationAttempts,
  secretRotationDuration,
  secretRotationStatus,
  secretRotationFailures,
  dlqDepth,
  dlqEnqueueTotal,
  dlqRetryTotal,
  recordDlqMessage,
  recordDlqFailure,
  recordDlqRetry,
};
