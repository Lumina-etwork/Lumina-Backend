const HistoricalUsageStore = require('./historicalUsageStore');
const trendCalculator = require('./trendCalculator');

const DEFAULT_WINDOWS = [
  { name: '7d', days: 7 },
  { name: '30d', days: 30 },
  { name: '90d', days: 90 },
];

class CapacityProjectionService {
  constructor({ store } = {}) {
    this.store = store || new HistoricalUsageStore();
  }

  async project(metricName, { daysAhead = 30, labels, source } = {}) {
    const to = new Date();
    const from = new Date(to.getTime() - 90 * 86400000);
    const raw = await this.store.getTimeSeries(metricName, { from, to, source, labels });
    if (!raw || raw.length < 2) return null;

    const timestamps = raw.map((r) => r.snapshot_time);
    const values = raw.map((r) => r.metric_value ?? r.avg_value);
    const result = trendCalculator.projectFromTimeSeries(timestamps, values, daysAhead);
    if (!result) return null;

    return {
      metric_name: metricName,
      labels: labels || null,
      source: source || null,
      data_points: raw.length,
      date_from: from,
      date_to: to,
      model: result.model,
      projections: result.projections,
      days_until_exhaustion: (limit) => result.daysUntilExhaustion(limit),
      confidence: result.model.r2 >= 0.7 ? 'high' : result.model.r2 >= 0.4 ? 'medium' : 'low',
    };
  }

  async getTrendSummary(metricName, { labels, source } = {}) {
    const to = new Date();
    const summaries = [];
    for (const w of DEFAULT_WINDOWS) {
      const from = new Date(to.getTime() - w.days * 86400000);
      const raw = await this.store.getTimeSeries(metricName, { from, to, source, labels });
      if (!raw || raw.length < 2) {
        summaries.push({ window: w.name, days: w.days, data_points: raw ? raw.length : 0, growth_rate: null, slope: null, r2: null });
        continue;
      }
      const values = raw.map((r) => r.metric_value ?? r.avg_value);
      const timestamps = raw.map((r) => r.snapshot_time);
      const baseSeconds = new Date(timestamps[0]).getTime() / 1000;
      const points = timestamps.map((t, i) => [new Date(t).getTime() / 1000 - baseSeconds, values[i]]);
      const model = trendCalculator.linearRegression(points);
      const gr = trendCalculator.growthRate(values);

      const sma = trendCalculator.simpleMovingAverage(values, Math.min(7, values.length));
      const anomalies = trendCalculator.detectAnomalies(values, sma, 3);
      const anomalyCount = anomalies.filter((a) => a.isAnomaly).length;

      const currentValue = values[values.length - 1];
      const projected7 = model.next(7 * 86400);
      const projected30 = model.next(30 * 86400);

      summaries.push({
        window: w.name,
        days: w.days,
        data_points: values.length,
        current_value: currentValue,
        growth_rate: parseFloat(gr.toFixed(6)),
        slope: parseFloat(model.slope.toFixed(10)),
        r2: parseFloat(model.r2.toFixed(4)),
        projected_7d: parseFloat(projected7.toFixed(4)),
        projected_30d: parseFloat(projected30.toFixed(4)),
        anomaly_count: anomalyCount,
      });
    }
    return summaries;
  }

  async daysUntilExhaustion(metricName, capacityLimit, { labels, source } = {}) {
    const to = new Date();
    const from = new Date(to.getTime() - 90 * 86400000);
    const raw = await this.store.getTimeSeries(metricName, { from, to, source, labels });
    if (!raw || raw.length < 2) return null;

    const timestamps = raw.map((r) => r.snapshot_time);
    const values = raw.map((r) => r.metric_value ?? r.avg_value);
    const result = trendCalculator.projectFromTimeSeries(timestamps, values, 90);
    if (!result) return null;

    const days = result.daysUntilExhaustion(capacityLimit);
    return days !== null ? { days: Math.max(0, Math.ceil(days)), exhausted: days <= 0, capacity_limit: capacityLimit } : { days: null, exhausted: false, capacity_limit: capacityLimit };
  }

  async getAlertState(metricName, { warningThreshold, criticalThreshold, capacityLimit, labels, source } = {}) {
    const current = await this.store.getLatestValue(metricName, labels);
    if (current == null) return { level: 'unknown', current_value: null };

    const state = { metric_name: metricName, current_value: current, level: 'ok', reasons: [] };

    if (criticalThreshold != null && current >= criticalThreshold) {
      state.level = 'critical';
      state.reasons.push(`Current value ${current} exceeds critical threshold ${criticalThreshold}`);
    } else if (warningThreshold != null && current >= warningThreshold) {
      state.level = 'warning';
      state.reasons.push(`Current value ${current} exceeds warning threshold ${warningThreshold}`);
    }

    if (capacityLimit != null) {
      const exhaustion = await this.daysUntilExhaustion(metricName, capacityLimit, { labels, source });
      if (exhaustion && exhaustion.days != null && exhaustion.days <= 14) {
        state.level = exhaustion.days <= 7 ? 'critical' : 'warning';
        state.reasons.push(`Projected to exhaust capacity in ${exhaustion.days} days (limit: ${capacityLimit})`);
        state.exhaustion_days = exhaustion.days;
      }
    }

    return state;
  }
}

module.exports = CapacityProjectionService;
