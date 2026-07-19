const DEFAULT_WINDOWS = [
  { name: 'fast', durationMinutes: 5, burnRateThreshold: 14.4, severity: 'page' },
  { name: 'slow', durationMinutes: 60, burnRateThreshold: 6, severity: 'ticket' },
];

const DEFAULT_SLO = {
  name: 'system-availability',
  objectivePercent: 99.99,
  latencyP99TargetMs: 100,
  compliancePeriodDays: 30,
};

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function errorBudgetPercent(objectivePercent) {
  return clamp(100 - objectivePercent, 0, 100);
}

function calculateBurnRate({ goodEvents, totalEvents, objectivePercent }) {
  if (!Number.isFinite(totalEvents) || totalEvents <= 0) return 0;
  const budget = errorBudgetPercent(objectivePercent);
  if (budget === 0) return 0;
  const badPercent = ((totalEvents - goodEvents) / totalEvents) * 100;
  return clamp(badPercent / budget, 0, Number.MAX_SAFE_INTEGER);
}

function calculateBudgetConsumedPercent({ goodEvents, totalEvents, objectivePercent }) {
  const burnRate = calculateBurnRate({ goodEvents, totalEvents, objectivePercent });
  return clamp(burnRate * 100, 0, Number.MAX_SAFE_INTEGER);
}

function evaluateWindow(window, sample, slo) {
  const burnRate = calculateBurnRate({
    goodEvents: sample.goodEvents,
    totalEvents: sample.totalEvents,
    objectivePercent: slo.objectivePercent,
  });
  const latencyViolation = Number.isFinite(sample.latencyP99Ms)
    && sample.latencyP99Ms > slo.latencyP99TargetMs;
  const budgetViolation = burnRate >= window.burnRateThreshold;

  return {
    window: window.name,
    severity: window.severity,
    burnRate,
    latencyP99Ms: sample.latencyP99Ms,
    budgetConsumedPercent: calculateBudgetConsumedPercent({
      goodEvents: sample.goodEvents,
      totalEvents: sample.totalEvents,
      objectivePercent: slo.objectivePercent,
    }),
    triggered: budgetViolation || latencyViolation,
    reasons: [
      budgetViolation ? `burn rate ${burnRate.toFixed(2)}x >= ${window.burnRateThreshold}x` : null,
      latencyViolation ? `P99 latency ${sample.latencyP99Ms}ms > ${slo.latencyP99TargetMs}ms` : null,
    ].filter(Boolean),
  };
}

class SloBurnRateMonitor {
  constructor(options = {}) {
    this.slo = { ...DEFAULT_SLO, ...(options.slo || {}) };
    this.windows = options.windows || DEFAULT_WINDOWS;
  }

  evaluate(samplesByWindow) {
    return this.windows.map((window) => {
      const sample = samplesByWindow[window.name] || { goodEvents: 0, totalEvents: 0, latencyP99Ms: 0 };
      return evaluateWindow(window, sample, this.slo);
    });
  }

  activeAlerts(samplesByWindow) {
    return this.evaluate(samplesByWindow).filter((result) => result.triggered);
  }

  prometheusRules(metricPrefix = 'lumina') {
    const availability = `${metricPrefix}:slo_availability_error_ratio`;
    const latency = `${metricPrefix}:http_request_duration_seconds:p99`;
    return this.windows.map((window) => ({
      alert: `LuminaSLOBurnRate${window.name[0].toUpperCase()}${window.name.slice(1)}`,
      expr: `(${availability}{window=\"${window.name}\"} / ${errorBudgetPercent(this.slo.objectivePercent) / 100}) >= ${window.burnRateThreshold} or ${latency}{window=\"${window.name}\"} > ${this.slo.latencyP99TargetMs / 1000}`,
      for: window.severity === 'page' ? '2m' : '10m',
      labels: { severity: window.severity, slo: this.slo.name },
      annotations: {
        summary: `${this.slo.name} SLO burn rate breach on ${window.name} window`,
        runbook: 'docs/runbooks/slo-burn-rate.md',
      },
    }));
  }
}

module.exports = {
  DEFAULT_SLO,
  DEFAULT_WINDOWS,
  SloBurnRateMonitor,
  calculateBurnRate,
  calculateBudgetConsumedPercent,
};
