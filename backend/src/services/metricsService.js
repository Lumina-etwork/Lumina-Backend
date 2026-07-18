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

const auditEventsTotal = new client.Counter({
  name: 'audit_events_total',
  help: 'Total audit events written to the tamper-evident audit trail',
  labelNames: ['action', 'result']
});

const auditVerificationTotal = new client.Counter({
  name: 'audit_hash_chain_verifications_total',
  help: 'Total audit hash-chain verification runs',
  labelNames: ['result']
});

const auditHashChainVerifiedEntries = new client.Gauge({
  name: 'audit_hash_chain_verified_entries',
  help: 'Number of audit entries checked in the most recent verification run'
});

register.registerMetric(apiResponseTime);
register.registerMetric(activeDbConnections);
register.registerMetric(totalIndexedBlocks);
register.registerMetric(auditEventsTotal);
register.registerMetric(auditVerificationTotal);
register.registerMetric(auditHashChainVerifiedEntries);

module.exports = {
  register,
  apiResponseTime,
  activeDbConnections,
  totalIndexedBlocks,
  auditEventsTotal,
  auditVerificationTotal,
  auditHashChainVerifiedEntries
};
