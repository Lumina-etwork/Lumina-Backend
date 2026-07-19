const MultiRegionDrService = require('../services/multiRegionDrService');

describe('MultiRegionDrService', () => {
  const regions = [
    { name: 'us-east-1', role: 'primary', priority: 0, databaseEndpoint: 'postgres://primary' },
    { name: 'us-west-2', role: 'replica', priority: 1, databaseEndpoint: 'postgres://west' },
    { name: 'eu-central-1', role: 'replica', priority: 2, databaseEndpoint: 'postgres://eu' },
  ];

  test('builds a deterministic multi-region topology with SLO targets', () => {
    const service = new MultiRegionDrService();
    const topology = service.buildTopology(regions);

    expect(topology.primaryRegion).toBe('us-east-1');
    expect(topology.failoverOrder).toEqual(['us-west-2', 'eu-central-1']);
    expect(topology.targets).toEqual({
      p99LatencyMs: 100,
      availabilityPercent: 99.99,
      rpoSeconds: 60,
      rtoSeconds: 300,
    });
  });

  test('rejects topologies without exactly one primary region', () => {
    const service = new MultiRegionDrService();
    expect(() => service.buildTopology([{ name: 'us-east-1', role: 'replica' }])).toThrow(
      'At least two regions are required',
    );
    expect(() => service.buildTopology([
      { name: 'us-east-1', role: 'primary' },
      { name: 'us-west-2', role: 'primary' },
    ])).toThrow('Exactly one primary region must be configured');
  });

  test('evaluates promotion readiness against lag, latency, and backup guardrails', () => {
    const service = new MultiRegionDrService();

    expect(service.evaluateRegionHealth({
      region: 'us-west-2',
      status: 'healthy',
      replicationLagMs: 200,
      criticalPathP99Ms: 80,
      lastBackupAgeSeconds: 30,
    })).toMatchObject({ readyForPromotion: true, score: 100 });

    expect(service.evaluateRegionHealth({
      region: 'eu-central-1',
      status: 'degraded',
      replicationLagMs: 6000,
      criticalPathP99Ms: 130,
      lastBackupAgeSeconds: 90,
    })).toMatchObject({
      readyForPromotion: false,
      violations: [
        'region_unhealthy',
        'replication_lag_exceeded',
        'critical_path_latency_exceeded',
        'backup_rpo_exceeded',
      ],
      score: 0,
    });
  });

  test('selects the first healthy replica for failover and falls back to manual intervention', () => {
    const service = new MultiRegionDrService();
    const topology = service.buildTopology(regions);

    expect(service.createFailoverPlan(topology, [
      { region: 'us-west-2', status: 'healthy', replicationLagMs: 100, criticalPathP99Ms: 75, lastBackupAgeSeconds: 20 },
    ])).toMatchObject({ decision: 'promote_replica', targetRegion: 'us-west-2' });

    expect(service.createFailoverPlan(topology, [
      { region: 'us-west-2', status: 'degraded', replicationLagMs: 9000, criticalPathP99Ms: 140, lastBackupAgeSeconds: 70 },
    ])).toMatchObject({ decision: 'manual_intervention_required' });
  });
});
