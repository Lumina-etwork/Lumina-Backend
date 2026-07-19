const { RuntimeConfigAuditService } = require('../services/runtimeConfigAuditService');

describe('RuntimeConfigAuditService', () => {
  test('creates deterministic redacted snapshots and hashes sensitive values', () => {
    const service = new RuntimeConfigAuditService({
      env: { NODE_ENV: 'test', JWT_SECRET: 'super-secret', PORT: '4000' },
      criticalKeys: ['JWT_SECRET', 'NODE_ENV', 'PORT'],
      clock: () => new Date('2026-07-18T00:00:00.000Z'),
    });

    const snapshot = service.buildSnapshot();

    expect(snapshot.keys).toEqual(['JWT_SECRET', 'NODE_ENV', 'PORT']);
    expect(snapshot.values.NODE_ENV).toBe('test');
    expect(snapshot.values.JWT_SECRET.redacted).toBe(true);
    expect(snapshot.values.JWT_SECRET.sha256).toHaveLength(64);
    expect(snapshot.values.JWT_SECRET).not.toHaveProperty('value');
    expect(snapshot.hash).toHaveLength(64);
  });

  test('detects drift against an in-memory baseline', () => {
    const env = { NODE_ENV: 'test', PORT: '4000' };
    const service = new RuntimeConfigAuditService({ env, criticalKeys: ['NODE_ENV', 'PORT'] });
    service.setBaseline();

    env.PORT = '5000';
    const result = service.audit();

    expect(result.status).toBe('drift_detected');
    expect(result.drift).toEqual([expect.objectContaining({ key: 'PORT', current: '5000', baseline: '4000' })]);
  });

  test('completes critical path audits under the 100ms target', () => {
    const env = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`KEY_${index}`, `value_${index}`]));
    const service = new RuntimeConfigAuditService({ env, criticalKeys: Object.keys(env) });

    const result = service.audit();

    expect(result.durationMs).toBeLessThan(100);
    expect(result.status).toBe('healthy');
  });
});
