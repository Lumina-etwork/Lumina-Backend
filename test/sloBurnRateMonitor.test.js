const assert = require('node:assert/strict');
const test = require('node:test');
const {
  SloBurnRateMonitor,
  calculateBurnRate,
  calculateBudgetConsumedPercent,
} = require('../src/monitoring/sloBurnRateMonitor');

test('calculates burn rate against a 99.99% availability error budget', () => {
  const burnRate = calculateBurnRate({ goodEvents: 999_850, totalEvents: 1_000_000, objectivePercent: 99.99 });
  assert.equal(Number(burnRate.toFixed(2)), 1.5);
  assert.equal(Number(calculateBudgetConsumedPercent({ goodEvents: 999_850, totalEvents: 1_000_000, objectivePercent: 99.99 }).toFixed(0)), 150);
});

test('triggers fast page alerts when burn rate exceeds the multi-window threshold', () => {
  const monitor = new SloBurnRateMonitor();
  const alerts = monitor.activeAlerts({
    fast: { goodEvents: 99_800, totalEvents: 100_000, latencyP99Ms: 80 },
    slow: { goodEvents: 999_950, totalEvents: 1_000_000, latencyP99Ms: 90 },
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].window, 'fast');
  assert.equal(alerts[0].severity, 'page');
});

test('triggers alerts for P99 critical-path latency over 100ms even without budget burn', () => {
  const monitor = new SloBurnRateMonitor();
  const alerts = monitor.activeAlerts({
    fast: { goodEvents: 100_000, totalEvents: 100_000, latencyP99Ms: 125 },
  });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].reasons[0], /P99 latency 125ms/);
});

test('renders Prometheus rules with SLO labels and runbook annotations', () => {
  const [fastRule] = new SloBurnRateMonitor().prometheusRules();
  assert.equal(fastRule.labels.slo, 'system-availability');
  assert.match(fastRule.expr, /lumina:slo_availability_error_ratio/);
  assert.equal(fastRule.annotations.runbook, 'docs/runbooks/slo-burn-rate.md');
});
