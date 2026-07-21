import { dbQueryDuration, cacheHitRatio, apiErrorRate } from './metrics.js';

export function buildThresholds(scenarioConfig) {
  const thresholds = {
    http_req_failed: ['rate<0.01'],
    http_req_duration: [
      `p(50)<${scenarioConfig.p50_max || 50}`,
      `p(95)<${scenarioConfig.p95_max || 200}`,
      `p(99)<${scenarioConfig.p99_max || 500}`,
    ],
    api_error_rate: [`rate<${scenarioConfig.error_rate_max || 0.01}`],
  };

  if (scenarioConfig.cache_hit_min !== undefined) {
    thresholds.cache_hit_ratio = [`rate>${scenarioConfig.cache_hit_min}`];
  }

  if (scenarioConfig.db_p95_max !== undefined) {
    thresholds.db_query_duration = [`p(95)<${scenarioConfig.db_p95_max}`];
  }

  return thresholds;
}

export function sharedSetup() {
  const { getConfig } = require('./config.js');
  return { config: getConfig() };
}
