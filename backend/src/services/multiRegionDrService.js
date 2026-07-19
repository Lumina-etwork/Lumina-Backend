const DEFAULT_CRITICAL_PATH_P99_MS = 100;
const DEFAULT_AVAILABILITY_TARGET = 99.99;
const DEFAULT_REPLICATION_LAG_THRESHOLD_MS = 5000;
const DEFAULT_RPO_SECONDS = 60;
const DEFAULT_RTO_SECONDS = 300;

class MultiRegionDrService {
  constructor(options = {}) {
    this.options = {
      criticalPathP99Ms: DEFAULT_CRITICAL_PATH_P99_MS,
      availabilityTarget: DEFAULT_AVAILABILITY_TARGET,
      replicationLagThresholdMs: DEFAULT_REPLICATION_LAG_THRESHOLD_MS,
      rpoSeconds: DEFAULT_RPO_SECONDS,
      rtoSeconds: DEFAULT_RTO_SECONDS,
      ...options,
    };
  }

  buildTopology(regions = []) {
    if (!Array.isArray(regions) || regions.length < 2) {
      throw new Error('At least two regions are required for disaster recovery');
    }

    const primaries = regions.filter((region) => region.role === 'primary');
    if (primaries.length !== 1) {
      throw new Error('Exactly one primary region must be configured');
    }

    const normalizedRegions = regions.map((region) => this.normalizeRegion(region));
    const primary = normalizedRegions.find((region) => region.role === 'primary');
    const replicas = normalizedRegions.filter((region) => region.role !== 'primary');

    return {
      primaryRegion: primary.name,
      writeStrategy: 'single-writer-with-fenced-promotion',
      readStrategy: 'latency-aware-read-replicas',
      replicationMode: 'async-streaming-with-wal-archive',
      targets: {
        p99LatencyMs: this.options.criticalPathP99Ms,
        availabilityPercent: this.options.availabilityTarget,
        rpoSeconds: this.options.rpoSeconds,
        rtoSeconds: this.options.rtoSeconds,
      },
      regions: normalizedRegions,
      failoverOrder: replicas
        .sort((left, right) => left.priority - right.priority)
        .map((region) => region.name),
    };
  }

  evaluateRegionHealth(snapshot) {
    const required = ['region', 'status', 'replicationLagMs', 'criticalPathP99Ms', 'lastBackupAgeSeconds'];
    required.forEach((field) => {
      if (snapshot[field] === undefined || snapshot[field] === null) {
        throw new Error(`Missing health field: ${field}`);
      }
    });

    const violations = [];
    if (snapshot.status !== 'healthy') violations.push('region_unhealthy');
    if (snapshot.replicationLagMs > this.options.replicationLagThresholdMs) violations.push('replication_lag_exceeded');
    if (snapshot.criticalPathP99Ms > this.options.criticalPathP99Ms) violations.push('critical_path_latency_exceeded');
    if (snapshot.lastBackupAgeSeconds > this.options.rpoSeconds) violations.push('backup_rpo_exceeded');

    return {
      region: snapshot.region,
      readyForPromotion: violations.length === 0,
      violations,
      score: Math.max(0, 100 - (violations.length * 25)),
    };
  }

  createFailoverPlan(topology, healthSnapshots = []) {
    const healthByRegion = new Map(
      healthSnapshots.map((snapshot) => [snapshot.region, this.evaluateRegionHealth(snapshot)]),
    );

    const candidate = topology.failoverOrder
      .map((regionName) => healthByRegion.get(regionName))
      .find((health) => health && health.readyForPromotion);

    if (!candidate) {
      return {
        decision: 'manual_intervention_required',
        reason: 'No replica satisfies promotion guardrails',
        runbook: 'docs/runbooks/multi-region-dr.md',
      };
    }

    return {
      decision: 'promote_replica',
      targetRegion: candidate.region,
      estimatedRtoSeconds: topology.targets.rtoSeconds,
      steps: [
        'freeze-primary-writes',
        'verify-replication-lag-and-backups',
        'promote-target-database',
        'shift-traffic-with-blue-green-canary',
        'reconcile-ledger-and-webhook-workers',
        'unfreeze-writes-after-slo-validation',
      ],
    };
  }

  normalizeRegion(region) {
    if (!region.name || !region.role) {
      throw new Error('Region name and role are required');
    }

    return {
      name: region.name,
      role: region.role,
      priority: Number.isInteger(region.priority) ? region.priority : 100,
      databaseEndpoint: region.databaseEndpoint || null,
      redisEndpoint: region.redisEndpoint || null,
      stellarRpcEndpoint: region.stellarRpcEndpoint || null,
    };
  }
}

module.exports = MultiRegionDrService;
