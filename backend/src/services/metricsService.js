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

const secretRotationAttempts = new client.Counter({
  name: 'secret_rotation_attempts_total',
  help: 'Total number of secret rotation attempts',
  labelNames: ['secret_type', 'provider']
});

const secretRotationFailures = new client.Counter({
  name: 'secret_rotation_failures_total',
  help: 'Total number of failed secret rotation attempts',
  labelNames: ['secret_type', 'provider']
});

const secretRotationDuration = new client.Histogram({
  name: 'secret_rotation_duration_seconds',
  help: 'Duration of secret rotation workflows in seconds',
  labelNames: ['secret_type', 'provider'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 3, 5, 10, 30]
});

const secretRotationStatus = new client.Gauge({
  name: 'secret_rotation_status',
  help: 'Latest secret rotation status by secret type and provider (1=healthy, 0=failed)',
  labelNames: ['secret_type', 'provider']
});

register.registerMetric(apiResponseTime);
register.registerMetric(activeDbConnections);
register.registerMetric(totalIndexedBlocks);
register.registerMetric(secretRotationAttempts);
register.registerMetric(secretRotationFailures);
register.registerMetric(secretRotationDuration);
register.registerMetric(secretRotationStatus);

module.exports = {
  register,
  apiResponseTime,
  activeDbConnections,
  totalIndexedBlocks,
  secretRotationAttempts,
  secretRotationFailures,
  secretRotationDuration,
  secretRotationStatus
};
