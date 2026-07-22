import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { SharedArray } from 'k6/data';
import { getConfig, buildHeaders } from '../helpers/config.js';
import { parseBenchmarkMetrics } from '../helpers/metrics.js';

const SCENARIO = 'stress-test';

export let options = {
  scenarios: {
    stress_ramp: {
      executor: 'ramping-arrival-rate',
      startRate: 100,
      timeUnit: '1s',
      preAllocatedVUs: 300,
      maxVUs: 1000,
      stages: [
        { target: 1000, duration: '1m' },
        { target: 3000, duration: '1m' },
        { target: 5000, duration: '1m' },
        { target: 5000, duration: '2m' },
        { target: 0, duration: '30s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(50)<200', 'p(95)<500', 'p(99)<1000'],
  },
  tags: { scenario: SCENARIO },
};

const VAULT_ADDRESSES = new SharedArray('vaults', function () {
  const env = __ENV.VAULT_ADDRESSES;
  if (env) {
    return env.split(',').filter(Boolean);
  }
  return new Array(20).fill(null).map((_, i) => `GSTRESS${String(i).padStart(7, '0')}`);
});

export default function () {
  const config = getConfig();
  const headers = buildHeaders();
  const vaultAddr = VAULT_ADDRESSES[Math.floor(Math.random() * VAULT_ADDRESSES.length)];

  group('reads', function () {
    const endpoints = [
      { url: `${config.targetUrl}/health`, tags: { endpoint: 'health' } },
      { url: `${config.targetUrl}/api/vaults/${vaultAddr}/schedule`, headers, tags: { endpoint: 'vault_schedule' } },
      { url: `${config.targetUrl}/api/vaults/${vaultAddr}/summary`, headers, tags: { endpoint: 'vault_summary' } },
      { url: `${config.targetUrl}/api/stats/tvl`, headers, tags: { endpoint: 'tvl' } },
    ];

    for (const ep of endpoints) {
      const res = http.get(ep.url, { headers: ep.headers || {}, tags: ep.tags });
      check(res, { 'read ok': (r) => r.status < 500 });
      parseBenchmarkMetrics(res);
    }
  });

  const writePayload = JSON.stringify({
    vault_address: vaultAddr,
    amount: (Math.random() * 10).toFixed(2),
    description: 'stress-test-benchmark',
  });
  const claimRes = http.post(
    `${config.targetUrl}/api/claims`,
    writePayload,
    { headers, tags: { endpoint: 'claims' } },
  );
  check(claimRes, { 'write ok': (r) => r.status < 500 });
  parseBenchmarkMetrics(claimRes);
}

export function handleSummary(data) {
  const metrics = data.metrics;
  return {
    stdout: JSON.stringify({
      scenario: SCENARIO,
      timestamp: new Date().toISOString(),
      metrics: {
        http_req_duration: {
          p50: metrics.http_req_duration.values.p50,
          p95: metrics.http_req_duration.values.p95,
          p99: metrics.http_req_duration.values.p99,
          avg: metrics.http_req_duration.values.avg,
          min: metrics.http_req_duration.values.min,
          max: metrics.http_req_duration.values.max,
        },
        http_reqs: {
          rate: metrics.http_reqs.values.rate,
          total: metrics.http_reqs.values.count,
        },
        http_req_failed: {
          rate: metrics.http_req_failed.values.rate,
          total: metrics.http_req_failed.values.fails,
        },
        http_req_waiting: {
          p50: metrics.http_req_waiting.values.p50,
          p95: metrics.http_req_waiting.values.p95,
          p99: metrics.http_req_waiting.values.p99,
        },
      },
      metadata: {
        vus_max: data.options.scenarios.stress_ramp.maxVUs,
        iterations: metrics.http_reqs.values.count,
        scenario: SCENARIO,
      },
    }),
  };
}
