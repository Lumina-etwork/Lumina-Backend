const { performance } = require('perf_hooks');

const dbQueryTimes = [];
const MAX_DB_SAMPLES = 10000;
const DB_SAMPLE_WINDOW_MS = 60000;

let cacheHits = 0;
let cacheMisses = 0;
let cacheGetTimes = [];
const MAX_CACHE_SAMPLES = 10000;

function isBenchmarkMode() {
  return process.env.BENCHMARK_MODE === 'true' || process.env.NODE_ENV === 'benchmark';
}

function recordDbQueryTime(durationMs) {
  if (!isBenchmarkMode()) return;
  const now = Date.now();
  dbQueryTimes.push({ durationMs, timestamp: now });
  if (dbQueryTimes.length > MAX_DB_SAMPLES) {
    dbQueryTimes.shift();
  }
  const cutoff = now - DB_SAMPLE_WINDOW_MS;
  while (dbQueryTimes.length > 0 && dbQueryTimes[0].timestamp < cutoff) {
    dbQueryTimes.shift();
  }
}

function recordCacheHit() {
  if (!isBenchmarkMode()) return;
  cacheHits++;
}

function recordCacheMiss() {
  if (!isBenchmarkMode()) return;
  cacheMisses++;
}

function recordCacheGetTime(durationMs) {
  if (!isBenchmarkMode()) return;
  cacheGetTimes.push(durationMs);
  if (cacheGetTimes.length > MAX_CACHE_SAMPLES) {
    cacheGetTimes.shift();
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function getMetrics() {
  if (!isBenchmarkMode()) {
    return {};
  }

  const now = Date.now();
  const cutoff = now - DB_SAMPLE_WINDOW_MS;
  const recentDbQueries = dbQueryTimes.filter(q => q.timestamp >= cutoff);
  const dbLatencies = recentDbQueries.map(q => q.durationMs).sort((a, b) => a - b);
  const cacheLatencies = cacheGetTimes.slice().sort((a, b) => a - b);
  const totalCacheOps = cacheHits + cacheMisses;

  return {
    db_query_latency_ms: dbLatencies.length > 0 ? {
      p50: percentile(dbLatencies, 50),
      p95: percentile(dbLatencies, 95),
      p99: percentile(dbLatencies, 99),
      avg: dbLatencies.reduce((a, b) => a + b, 0) / dbLatencies.length,
      count: dbLatencies.length,
    } : null,
    cache_hit_ratio: totalCacheOps > 0 ? cacheHits / totalCacheOps : null,
    cache_ops_total: totalCacheOps,
    cache_hits_total: cacheHits,
    cache_misses_total: cacheMisses,
    cache_get_latency_ms: cacheLatencies.length > 0 ? {
      p50: percentile(cacheLatencies, 50),
      p95: percentile(cacheLatencies, 95),
      avg: cacheLatencies.reduce((a, b) => a + b, 0) / cacheLatencies.length,
      count: cacheLatencies.length,
    } : null,
  };
}

function resetMetrics() {
  dbQueryTimes.length = 0;
  cacheGetTimes.length = 0;
  cacheHits = 0;
  cacheMisses = 0;
}

function createSequelizeHook(sequelize) {
  if (!sequelize || !isBenchmarkMode()) return;

  sequelize.addHook('beforeQuery', (options) => {
    options._benchmarkStart = performance.now();
  });

  sequelize.addHook('afterQuery', (options) => {
    if (options._benchmarkStart) {
      const duration = performance.now() - options._benchmarkStart;
      recordDbQueryTime(duration);
    }
  });
}

module.exports = {
  recordDbQueryTime,
  recordCacheHit,
  recordCacheMiss,
  recordCacheGetTime,
  getMetrics,
  resetMetrics,
  createSequelizeHook,
  isBenchmarkMode,
};
