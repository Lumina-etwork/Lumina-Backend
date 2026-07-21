import { Trend, Rate, Counter } from 'k6/metrics';

export const dbQueryDuration = new Trend('db_query_duration', true);
export const cacheHitRatio = new Rate('cache_hit_ratio');
export const cacheHitCounter = new Counter('cache_hit_total');
export const cacheMissCounter = new Counter('cache_miss_total');
export const apiErrorRate = new Rate('api_error_rate');

const ENDPOINT_MAP = {
  'GET /health': { tags: { endpoint: 'health', method: 'GET' } },
  'GET /api/vaults/:address/schedule': { tags: { endpoint: 'vault_schedule', method: 'GET' } },
  'GET /api/vaults/:address/summary': { tags: { endpoint: 'vault_summary', method: 'GET' } },
  'POST /api/claims': { tags: { endpoint: 'claims', method: 'POST' } },
  'GET /api/stats/tvl': { tags: { endpoint: 'tvl', method: 'GET' } },
  'GET /api/auth/me': { tags: { endpoint: 'auth_me', method: 'GET' } },
};

export function parseBenchmarkMetrics(response) {
  if (response.status === 200 && response.json().benchmark) {
    const bm = response.json().benchmark;
    if (bm.db_query_latency_ms !== undefined) {
      dbQueryDuration.add(bm.db_query_latency_ms);
    }
    if (bm.cache_hit_ratio !== undefined) {
      cacheHitRatio.add(bm.cache_hit_ratio > 0.5);
    }
  }
}

export { ENDPOINT_MAP };
