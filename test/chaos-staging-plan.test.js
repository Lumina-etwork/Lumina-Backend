const { buildPlan, experiments, validateExperiment } = require('../scripts/chaos-staging-plan');

describe('staging chaos plan', () => {
  test('builds a staging-only plan with release guardrails', () => {
    const plan = buildPlan();

    expect(plan.environment).toBe('staging');
    expect(plan.performanceTarget).toBe('p99_latency_ms < 100');
    expect(plan.availabilityTarget).toBe('99.99%');
    expect(plan.securityReviewRequired).toBe(true);
    expect(plan.experiments).toHaveLength(6);
  });

  test('requires guardrails for every experiment', () => {
    experiments.forEach((experiment) => {
      expect(experiment.guardrails.length).toBeGreaterThan(0);
      expect(() => validateExperiment(experiment)).not.toThrow();
    });
  });

  test('rejects experiments without abort thresholds', () => {
    expect(() => validateExperiment({ id: 'unsafe', service: 'api', injection: 'latency', blastRadius: 'all', guardrails: ['p99_latency_ms < 100'] })).toThrow('abortAfterMinutes');
  });
});
