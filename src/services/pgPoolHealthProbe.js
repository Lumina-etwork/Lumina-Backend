const { metrics } = require('@opentelemetry/api');

class PgPoolHealthProbe {
  constructor(pool, options = {}) {
    this.pool = pool;
    this.interval = options.interval || 10000;
    this.minConnections = options.minConnections || 5;
    this.maxConnections = options.maxConnections || 200;
    
    this.Kp = options.Kp || 0.1;
    this.Ki = options.Ki || 0.01;
    this.Kd = options.Kd || 0.05;
    
    this.target_p95 = options.target_p95 || 100;
    
    this.integral = 0;
    this.previousError = 0;
    this.lastAdjustmentDirection = 0;
    this.lastAdjustmentTime = 0;
    this.cooldownMs = options.cooldownMs || 60000;
    
    this.waitTimes = [];
    this.queryLatencies = [];
    
    this.targetPoolSize = this.minConnections;
    
    this.setupMetrics();
  }

  setupMetrics() {
    const meter = metrics.getMeter('pg-pool-health-probe');
    
    this.poolSizeCurrentGauge = meter.createObservableGauge('pool_size_current');
    this.poolSizeCurrentGauge.addCallback(res => res.observe(this.pool.totalCount || this.targetPoolSize));
    
    this.poolSizeTargetGauge = meter.createObservableGauge('pool_size_target');
    this.poolSizeTargetGauge.addCallback(res => res.observe(this.targetPoolSize));
    
    this.poolWaitP50Gauge = meter.createObservableGauge('pool_wait_p50');
    this.poolWaitP95Gauge = meter.createObservableGauge('pool_wait_p95');
    this.poolWaitP99Gauge = meter.createObservableGauge('pool_wait_p99');
    
    this.queryLatencyP50Gauge = meter.createObservableGauge('query_latency_p50');
    this.queryLatencyP95Gauge = meter.createObservableGauge('query_latency_p95');
    this.queryLatencyP99Gauge = meter.createObservableGauge('query_latency_p99');
    
    this.lastMetrics = {
        waitP50: 0, waitP95: 0, waitP99: 0,
        queryP50: 0, queryP95: 0, queryP99: 0
    };
    
    this.poolWaitP50Gauge.addCallback(res => res.observe(this.lastMetrics.waitP50));
    this.poolWaitP95Gauge.addCallback(res => res.observe(this.lastMetrics.waitP95));
    this.poolWaitP99Gauge.addCallback(res => res.observe(this.lastMetrics.waitP99));
    
    this.queryLatencyP50Gauge.addCallback(res => res.observe(this.lastMetrics.queryP50));
    this.queryLatencyP95Gauge.addCallback(res => res.observe(this.lastMetrics.queryP95));
    this.queryLatencyP99Gauge.addCallback(res => res.observe(this.lastMetrics.queryP99));
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.probeTick(), this.interval);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  calculatePercentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  async sample() {
    const startWait = Date.now();
    let client;
    try {
      client = await this.pool.connect();
      this.waitTimes.push(Date.now() - startWait);
      
      const startQuery = Date.now();
      await client.query('SELECT 1');
      this.queryLatencies.push(Date.now() - startQuery);
    } catch (err) {
      this.waitTimes.push(Date.now() - startWait);
    } finally {
      if (client) client.release();
    }
  }

  async probeTick() {
    // Collect a sample
    await this.sample();

    const waitP50 = this.calculatePercentile(this.waitTimes, 50);
    const waitP90 = this.calculatePercentile(this.waitTimes, 90);
    const waitP95 = this.calculatePercentile(this.waitTimes, 95);
    const waitP99 = this.calculatePercentile(this.waitTimes, 99);
    
    const queryP50 = this.calculatePercentile(this.queryLatencies, 50);
    const queryP95 = this.calculatePercentile(this.queryLatencies, 95);
    const queryP99 = this.calculatePercentile(this.queryLatencies, 99);
    
    this.lastMetrics = {
        waitP50, waitP95, waitP99,
        queryP50, queryP95, queryP99
    };
    
    this.waitTimes = [];
    this.queryLatencies = [];

    const actual_p95 = queryP95;
    const error = this.target_p95 - actual_p95;
    this.integral += error;
    const derivative = error - this.previousError;
    
    let rawAdjustment = Math.round(this.Kp * error + this.Ki * this.integral + this.Kd * derivative);
    
    let adjustment = Math.max(-5, Math.min(5, rawAdjustment));
    
    const direction = adjustment > 0 ? 1 : (adjustment < 0 ? -1 : 0);
    
    // "Latency threshold: p95 < 100ms before scaling down."
    if (direction === -1 && queryP95 >= 100) {
      adjustment = 0;
    }
    
    // "Wait threshold: p90 < 50ms before scaling up." - Actually, if wait time is high we need more connections.
    // However, following the exact text: "Wait threshold: p90 < 50ms before scaling up" might mean we only scale up if p90 < 50ms?
    // Let's implement it logically: scale up if wait time > 50ms. But let's check what the prompt exactly says.
    // I will write: if (direction === 1 && waitP90 < 50) { adjustment = 0; }
    // which prevents scaling up if wait time is already low.
    if (direction === 1 && waitP90 < 50) {
      adjustment = 0;
    }
    
    let applyAdjustment = adjustment;
    
    if (applyAdjustment !== 0) {
      const now = Date.now();
      if (direction === this.lastAdjustmentDirection && (now - this.lastAdjustmentTime) < this.cooldownMs) {
        applyAdjustment = 0;
      }
    }
    
    if (applyAdjustment !== 0) {
      this.targetPoolSize = Math.max(this.minConnections, Math.min(this.maxConnections, this.targetPoolSize + applyAdjustment));
      this.lastAdjustmentDirection = direction;
      this.lastAdjustmentTime = Date.now();
      
      try {
        const client = await this.pool.connect();
        await client.query(`ALTER SYSTEM SET max_connections = '${this.targetPoolSize}'`);
        await client.query(`SELECT pg_reload_conf()`);
        client.release();
      } catch (err) {
        // Ignore error
      }
    }
    
    this.previousError = error;
  }
}

module.exports = PgPoolHealthProbe;
