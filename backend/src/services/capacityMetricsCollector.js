const client = require('prom-client');
const { register } = require('./metricsService');
const HistoricalUsageStore = require('./historicalUsageStore');
const { sequelize } = require('../database/connection');

const COLLECTED_METRICS = [
  'api_response_time_seconds',
  'active_db_connections',
  'total_indexed_ledger_blocks',
  'dlq_messages_total',
  'dlq_capture_failures_total',
  'dlq_retries_total',
  'scheduler_claim_latency_seconds',
  'scheduler_jobs_claimed_total',
  'scheduler_jobs_completed_total',
  'scheduler_jobs_failed_total',
];

const SYSTEM_METRICS = [
  { name: 'process_cpu_usage_ratio', source: 'process' },
  { name: 'process_memory_rss_bytes', source: 'process' },
  { name: 'process_memory_heap_total_bytes', source: 'process' },
  { name: 'process_memory_heap_used_bytes', source: 'process' },
  { name: 'process_uptime_seconds', source: 'process' },
  { name: 'event_loop_lag_ms', source: 'process' },
];

const DB_METRICS = [
  { name: 'active_db_connections', source: 'postgres' },
  { name: 'db_pool_total', source: 'postgres' },
  { name: 'db_pool_idle', source: 'postgres' },
  { name: 'db_pool_waiting', source: 'postgres' },
];

class CapacityMetricsCollector {
  constructor({ store, metricNames } = {}) {
    this.store = store || new HistoricalUsageStore();
    this.metricNames = metricNames || COLLECTED_METRICS;
    this._running = false;
  }

  async collectOnce() {
    const entries = [];
    const now = new Date();

    for (const metricName of this.metricNames) {
      const gauge = register.getSingleMetric(metricName);
      if (!gauge) continue;
      try {
        const values = await gauge.get();
        if (!values || !values.values) continue;
        for (const v of values.values) {
          entries.push({
            metric_name: metricName,
            metric_value: v.value,
            labels: v.labels || {},
            snapshot_time: now,
            source: 'prometheus',
            data_quality: 'good',
          });
        }
      } catch {
        // skip metrics that fail to collect
      }
    }

    for (const sm of SYSTEM_METRICS) {
      const entry = this._collectSystemMetric(sm.name);
      if (entry != null) {
        entries.push({
          metric_name: sm.name,
          metric_value: entry.value,
          labels: {},
          snapshot_time: now,
          source: sm.source,
          data_quality: 'good',
        });
      }
    }

    for (const dm of DB_METRICS) {
      try {
        const entry = await this._collectDbMetric(dm.name);
        if (entry != null) {
          entries.push({
            metric_name: dm.name,
            metric_value: entry.value,
            labels: entry.labels || {},
            snapshot_time: now,
            source: dm.source,
            data_quality: 'good',
          });
        }
      } catch {
        // skip DB metrics that fail
      }
    }

    if (entries.length > 0) {
      await this.store.record(entries);
    }
    return entries.length;
  }

  _collectSystemMetric(name) {
    switch (name) {
      case 'process_cpu_usage_ratio': {
        const usage = process.cpuUsage();
        const total = usage.user + usage.system;
        return { value: total / 1000000 };
      }
      case 'process_memory_rss_bytes':
        return { value: process.memoryUsage().rss };
      case 'process_memory_heap_total_bytes':
        return { value: process.memoryUsage().heapTotal };
      case 'process_memory_heap_used_bytes':
        return { value: process.memoryUsage().heapUsed };
      case 'process_uptime_seconds':
        return { value: process.uptime() };
      case 'event_loop_lag_ms': {
        const start = Date.now();
        const MS_10 = 10;
        const waitUntil = start + MS_10;
        while (Date.now() < waitUntil) { /* spin */ }
        return { value: Date.now() - start };
      }
      default:
        return null;
    }
  }

  async _collectDbMetric(name) {
    try {
      const pool = sequelize?.connectionManager?.pool;
      if (!pool) return null;
      switch (name) {
        case 'active_db_connections':
          return { value: pool.size, labels: { type: 'write' } };
        case 'db_pool_total':
          return { value: pool.size };
        case 'db_pool_idle':
          return { value: pool.idle };
        case 'db_pool_waiting':
          return { value: pool.waiting };
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  start(intervalMs = 60000) {
    if (this._running) return;
    this._running = true;
    this._interval = setInterval(() => {
      this.collectOnce().catch((err) => {
        console.error('Capacity metrics collection error:', err);
      });
    }, intervalMs);
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._running = false;
  }
}

module.exports = CapacityMetricsCollector;
