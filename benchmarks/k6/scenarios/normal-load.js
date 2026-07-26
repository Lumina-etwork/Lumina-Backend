import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { SharedArray } from 'k6/data';
import { getConfig, buildHeaders } from '../helpers/config.js';
import { parseBenchmarkMetrics } from '../helpers/metrics.js';

const SCENARIO = 'normal-load';

export let options = {
  scenarios: {
    normal_load: {
      executor: 'constant-arrival-rate',
      rate: 100,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 50,
      maxVUs: 100,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(50)<50', 'p(95)<150', 'p(99)<300'],
    http_reqs: ['rate>80'],
  },
  tags: { scenario: SCENARIO },
};

const VAULT_ADDRESSES = new SharedArray('vaults', function () {
  const env = __ENV.VAULT_ADDRESSES;
  if (env) {
    return env.split(',').filter(Boolean);
  }
  return ['GABCDEF1234567890abcdef1234567890abcdef12'];
});

export default function () {
  const config = getConfig();
  const headers = buildHeaders();
  const vaultAddr = VAULT_ADDRESSES[Math.floor(Math.random() * VAULT_ADDRESSES.length)];

  group('health check', function () {
    const res = http.get(`${config.targetUrl}/health`, {
      tags: { endpoint: 'health' },
    });
    check(res, {
      'health status is 200': (r) => r.status === 200,
    });
  });

  sleep(Math.random() * 0.2);

  group('vault read operations', function () {
    const scheduleRes = http.get(
      `${config.targetUrl}/api/vaults/${vaultAddr}/schedule`,
      { headers, tags: { endpoint: 'vault_schedule' } },
    );
    check(scheduleRes, {
      'schedule request succeeded': (r) => r.status === 200 || r.status === 404,
    });
    parseBenchmarkMetrics(scheduleRes);

    const summaryRes = http.get(
      `${config.targetUrl}/api/vaults/${vaultAddr}/summary`,
      { headers, tags: { endpoint: 'vault_summary' } },
    );
    check(summaryRes, {
      'summary request succeeded': (r) => r.status === 200 || r.status === 404,
    });
    parseBenchmarkMetrics(summaryRes);
  });

  sleep(Math.random() * 0.3);

  group('stats and reads', function () {
    const tvlRes = http.get(`${config.targetUrl}/api/stats/tvl`, {
      headers,
      tags: { endpoint: 'tvl' },
    });
    check(tvlRes, {
      'tvl request succeeded': (r) => r.status === 200,
    });
    parseBenchmarkMetrics(tvlRes);
  });

  sleep(Math.random() * 0.3);
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
        vus_max: data.options.scenarios.normal_load.maxVUs,
        iterations: data.metrics.http_reqs.values.count,
        scenario: SCENARIO,
      },
    }),
  };
}
