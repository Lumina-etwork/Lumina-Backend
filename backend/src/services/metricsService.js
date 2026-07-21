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

const dlqMessagesTotal = new client.Counter({
  name: 'dlq_messages_total',
  help: 'Total number of messages moved to the dead letter queue',
  labelNames: ['source_queue', 'job_name', 'reason'],
});

const dlqCaptureFailuresTotal = new client.Counter({
  name: 'dlq_capture_failures_total',
  help: 'Total number of failures while moving messages to the dead letter queue',
  labelNames: ['source_queue', 'reason'],
});

const dlqRetriesTotal = new client.Counter({
  name: 'dlq_retries_total',
  help: 'Total number of dead letter queue messages manually replayed',
  labelNames: ['source_queue', 'job_name'],
});

const capacityDbPoolUsage = new client.Gauge({
  name: 'lumina_capacity_db_pool_usage_ratio',
  help: 'Database connection pool usage ratio (0-1)',
  labelNames: ['type'],
});

const capacityQueueDepth = new client.Gauge({
  name: 'lumina_capacity_queue_depth',
  help: 'Current depth of BullMQ queues',
  labelNames: ['queue'],
});

const capacityDlqDepth = new client.Gauge({
  name: 'lumina_capacity_dlq_depth',
  help: 'Current number of messages in the dead letter queue',
  labelNames: ['source_queue'],
});

const capacityProcessCpuRatio = new client.Gauge({
  name: 'lumina_capacity_process_cpu_ratio',
  help: 'Node.js process CPU usage ratio (0-1)',
});

const capacityProcessMemoryBytes = new client.Gauge({
  name: 'lumina_capacity_process_memory_bytes',
  help: 'Node.js process memory usage in bytes',
  labelNames: ['type'],
});

const capacityEventLoopLagMs = new client.Gauge({
  name: 'lumina_capacity_event_loop_lag_ms',
  help: 'Event loop lag in milliseconds',
});

const capacityThroughputTrendSlope = new client.Gauge({
  name: 'lumina_capacity_throughput_trend_slope',
  help: 'Trend slope for throughput metrics',
  labelNames: ['route', 'method'],
});

const capacityProjectedExhaustionDays = new client.Gauge({
  name: 'lumina_capacity_projected_exhaustion_days',
  help: 'Projected days until capacity limit is reached',
  labelNames: ['metric', 'limit'],
});

const capacityAnomalyCount = new client.Gauge({
  name: 'lumina_capacity_anomaly_count',
  help: 'Number of detected anomalies per metric',
  labelNames: ['metric'],
});

register.registerMetric(apiResponseTime);
register.registerMetric(activeDbConnections);
register.registerMetric(totalIndexedBlocks);
register.registerMetric(dlqMessagesTotal);
register.registerMetric(dlqCaptureFailuresTotal);
register.registerMetric(dlqRetriesTotal);
register.registerMetric(capacityDbPoolUsage);
register.registerMetric(capacityQueueDepth);
register.registerMetric(capacityDlqDepth);
register.registerMetric(capacityProcessCpuRatio);
register.registerMetric(capacityProcessMemoryBytes);
register.registerMetric(capacityEventLoopLagMs);
register.registerMetric(capacityThroughputTrendSlope);
register.registerMetric(capacityProjectedExhaustionDays);
register.registerMetric(capacityAnomalyCount);

module.exports = {
  register,
  apiResponseTime,
  activeDbConnections,
  totalIndexedBlocks,
  dlqMessagesTotal,
  dlqCaptureFailuresTotal,
  dlqRetriesTotal,
  capacityDbPoolUsage,
  capacityQueueDepth,
  capacityDlqDepth,
  capacityProcessCpuRatio,
  capacityProcessMemoryBytes,
  capacityEventLoopLagMs,
  capacityThroughputTrendSlope,
  capacityProjectedExhaustionDays,
  capacityAnomalyCount,
  recordDlqMessage(sourceQueue, jobName, reason) {
    dlqMessagesTotal.inc({ source_queue: sourceQueue, job_name: jobName, reason });
  },
  recordDlqFailure(sourceQueue, reason) {
    dlqCaptureFailuresTotal.inc({ source_queue: sourceQueue, reason });
  },
  recordDlqRetry(sourceQueue, jobName) {
    dlqRetriesTotal.inc({ source_queue: sourceQueue, job_name: jobName });
  }
};
