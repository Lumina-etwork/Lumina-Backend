export function getConfig() {
  return {
    targetUrl: __ENV.TARGET_URL || 'http://localhost:3000',
    authToken: __ENV.AUTH_TOKEN || '',
    payloadSize: parseInt(__ENV.PAYLOAD_SIZE || '256', 10),
    benchmarkApiKey: __ENV.BENCHMARK_API_KEY || '',
  };
}

export function buildHeaders(customHeaders = {}) {
  const config = getConfig();
  const headers = {
    'Content-Type': 'application/json',
    ...customHeaders,
  };
  if (config.authToken) {
    headers['Authorization'] = `Bearer ${config.authToken}`;
  }
  if (config.benchmarkApiKey) {
    headers['X-Benchmark-Key'] = config.benchmarkApiKey;
  }
  return headers;
}
