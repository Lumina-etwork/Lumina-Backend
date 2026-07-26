import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { SharedArray } from 'k6/data';
import { getConfig, buildHeaders } from '../helpers/config.js';
import { parseBenchmarkMetrics } from '../helpers/metrics.js';

const SCENARIO = 'peak-load';

export let options = {
  scenarios: {
    peak_load: {
      executor: 'constant-arrival-rate',
      rate: 1000,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 200,
      maxVUs: 500,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(50)<100', 'p(95)<300', 'p(99)<600'],
    http_reqs: ['rate>800'],
  },
  tags: { scenario: SCENARIO },
};

const VAULT_ADDRESSES = new SharedArray('vaults', function () {
  const env = __ENV.VAULT_ADDRESSES;
  if (env) {
    return env.split(',').filter(Boolean);
  }
  return [
    'GA000001...', 'GA000002...', 'GA000003...', 'GA000004...', 'GA000005...',
  ];
});

export default function () {
  const config = getConfig();
  const headers = buildHeaders();
  const vaultAddr = VAULT_ADDRESSES[Math.floor(Math.random() * VAULT_ADDRESSES.length)];

  group('health + reads', function () {
    const healthRes = http.get(`${config.targetUrl}/health`, {
      tags: { endpoint: 'health' },
    });
    check(healthRes, { 'health ok': (r) => r.status === 200 });

    const scheduleRes = http.get(
      `${config.targetUrl}/api/vaults/${vaultAddr}/schedule`,
      { headers, tags: { endpoint: 'vault_schedule' } },
    );
    check(scheduleRes, { 'schedule ok': (r) => r.status < 500 });
    parseBenchmarkMetrics(scheduleRes);

    const tvlRes = http.get(`${config.targetUrl}/api/stats/tvl`, {
      headers,
      tags: { endpoint: 'tvl' },
    });
    check(tvlRes, { 'tvl ok': (r) => r.status === 200 });
    parseBenchmarkMetrics(tvlRes);
  });

  sleep(Math.random() * 0.1);

  group('write operations', function () {
    const claimPayload = JSON.stringify({
      vault_address: vaultAddr,
      amount: (Math.random() * 100).toFixed(2),
    });
    const claimRes = http.post(
      `${config.targetUrl}/api/claims`,
      claimPayload,
      { headers, tags: { endpoint: 'claims' } },
    );
    check(claimRes, { 'claim submitted': (r) => r.status < 500 });
    parseBenchmarkMetrics(claimRes);
  });

  sleep(Math.random() * 0.15);
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
        vus_max: data.options.scenarios.peak_load.maxVUs,
        iterations: metrics.http_reqs.values.count,
        scenario: SCENARIO,
      },
    }),
  };
}
