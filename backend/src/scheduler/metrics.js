const client = require('prom-client');
const { register } = require('../services/metricsService');

function metric(name, create) {
  return register.getSingleMetric(name) || create();
}

const schedulerClaimLatency = metric('scheduler_claim_latency_seconds', () => new client.Histogram({
  name: 'scheduler_claim_latency_seconds',
  help: 'Latency for distributed scheduler claim critical path',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 1],
}));
const schedulerJobsClaimed = metric('scheduler_jobs_claimed_total', () => new client.Counter({ name: 'scheduler_jobs_claimed_total', help: 'Total scheduler jobs claimed' }));
const schedulerJobsCompleted = metric('scheduler_jobs_completed_total', () => new client.Counter({ name: 'scheduler_jobs_completed_total', help: 'Total scheduler jobs completed' }));
const schedulerJobsFailed = metric('scheduler_jobs_failed_total', () => new client.Counter({ name: 'scheduler_jobs_failed_total', help: 'Total scheduler jobs failed' }));

for (const m of [schedulerClaimLatency, schedulerJobsClaimed, schedulerJobsCompleted, schedulerJobsFailed]) {
  if (!register.getSingleMetric(m.name)) register.registerMetric(m);
}

module.exports = {
  schedulerClaimLatency,
  claimed: schedulerJobsClaimed,
  completed: schedulerJobsCompleted,
  failed: schedulerJobsFailed,
};
