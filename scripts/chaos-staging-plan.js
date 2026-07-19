#!/usr/bin/env node
'use strict';

const experiments = [
  {
    id: 'api-latency-small-blast-radius',
    service: 'api',
    injection: 'network-latency',
    blastRadius: '10% of staging API pods',
    guardrails: ['p99_latency_ms < 100', 'availability_projection >= 99.99', 'error_rate < 1%'],
    abortAfterMinutes: 5,
  },
  {
    id: 'database-brownout',
    service: 'postgres',
    injection: 'connection-refusal-and-query-latency',
    blastRadius: 'staging database clients only',
    guardrails: ['write_failure_rate < 1%', 'circuit_breaker_state == open_or_half_open', 'no_data_corruption_events'],
    abortAfterMinutes: 3,
  },
  {
    id: 'redis-degradation',
    service: 'redis',
    injection: 'packet-loss',
    blastRadius: '20% cache operations in staging',
    guardrails: ['queue_backlog_stable', 'p99_latency_ms < 100', 'cache_fallback_success_rate >= 99%'],
    abortAfterMinutes: 5,
  },
  {
    id: 'stellar-rpc-outage',
    service: 'stellar-rpc',
    injection: '429-5xx-timeout',
    blastRadius: 'staging RPC adapter',
    guardrails: ['retry_backoff_active', 'no_retry_storm', 'deterministic_user_status'],
    abortAfterMinutes: 2,
  },
  {
    id: 'websocket-pod-churn',
    service: 'websocket',
    injection: 'pod-termination',
    blastRadius: '25% websocket pods',
    guardrails: ['reconnect_success_rate >= 99%', 'duplicate_event_count == 0', 'subscription_resync_success'],
    abortAfterMinutes: 5,
  },
  {
    id: 'kubernetes-node-drain',
    service: 'kubernetes',
    injection: 'node-drain',
    blastRadius: 'one staging worker node',
    guardrails: ['pdb_quorum_preserved', 'max_unavailable_replicas <= 1', 'traffic_shift_success'],
    abortAfterMinutes: 5,
  },
];

function validateExperiment(experiment) {
  const requiredFields = ['id', 'service', 'injection', 'blastRadius', 'guardrails', 'abortAfterMinutes'];
  const missing = requiredFields.filter((field) => experiment[field] === undefined || experiment[field] === null);

  if (missing.length > 0) {
    throw new Error(`${experiment.id || 'unknown'} is missing fields: ${missing.join(', ')}`);
  }

  if (!Array.isArray(experiment.guardrails) || experiment.guardrails.length === 0) {
    throw new Error(`${experiment.id} must define at least one guardrail`);
  }

  if (!Number.isInteger(experiment.abortAfterMinutes) || experiment.abortAfterMinutes <= 0) {
    throw new Error(`${experiment.id} must define a positive abortAfterMinutes value`);
  }
}

function buildPlan() {
  experiments.forEach(validateExperiment);

  return {
    environment: 'staging',
    performanceTarget: 'p99_latency_ms < 100',
    availabilityTarget: '99.99%',
    securityReviewRequired: true,
    experiments,
  };
}

if (require.main === module) {
  const plan = buildPlan();

  if (process.argv.includes('--validate')) {
    console.log(`Validated ${plan.experiments.length} staging chaos experiments.`);
    process.exit(0);
  }

  console.log(JSON.stringify(plan, null, 2));
}

module.exports = { buildPlan, experiments, validateExperiment };
