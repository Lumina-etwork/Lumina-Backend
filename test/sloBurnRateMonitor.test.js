/* eslint-env jest, node */
const {
  SloBurnRateMonitor,
  calculateBurnRate,
  calculateBudgetConsumedPercent,
} = require('../src/monitoring/sloBurnRateMonitor');

describe('sloBurnRateMonitor', () => {
  it('calculates burn rate against a 99.99% availability error budget', () => {
    const burnRate = calculateBurnRate({ goodEvents: 999_850, totalEvents: 1_000_000, objectivePercent: 99.99 });
    expect(Number(burnRate.toFixed(2))).toBe(1.5);
    expect(Number(calculateBudgetConsumedPercent({ goodEvents: 999_850, totalEvents: 1_000_000, objectivePercent: 99.99 }).toFixed(0))).toBe(150);
  });

  it('triggers fast page alerts when burn rate exceeds the multi-window threshold', () => {
    const monitor = new SloBurnRateMonitor();
    const alerts = monitor.activeAlerts({
      fast: { goodEvents: 99_800, totalEvents: 100_000, latencyP99Ms: 80 },
      slow: { goodEvents: 999_950, totalEvents: 1_000_000, latencyP99Ms: 90 },
    });
    expect(alerts.length).toBe(1);
    expect(alerts[0].window).toBe('fast');
    expect(alerts[0].severity).toBe('page');
  });

  it('triggers alerts for P99 critical-path latency over 100ms even without budget burn', () => {
    const monitor = new SloBurnRateMonitor();
    const alerts = monitor.activeAlerts({
      fast: { goodEvents: 100_000, totalEvents: 100_000, latencyP99Ms: 125 },
    });
    expect(alerts.length).toBe(1);
    expect(alerts[0].reasons[0]).toMatch(/P99 latency 125ms/);
  });

  it('renders Prometheus rules with SLO labels and runbook annotations', () => {
    const [fastRule] = new SloBurnRateMonitor().prometheusRules();
    expect(fastRule.labels.slo).toBe('system-availability');
    expect(fastRule.expr).toMatch(/lumina:slo_availability_error_ratio/);
    expect(fastRule.annotations.runbook).toBe('docs/runbooks/slo-burn-rate.md');
  });
});

