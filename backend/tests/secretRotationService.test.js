const SecretRotationService = require('../src/services/secretRotationService');

function buildConfig(overrides = {}) {
  return {
    name: 'database/password',
    type: 'database',
    provider: 'vault',
    rotationIntervalMs: 1000,
    lastRotatedAt: 0,
    writeCandidate: jest.fn().mockResolvedValue(undefined),
    validateCandidate: jest.fn().mockResolvedValue(undefined),
    promoteCandidate: jest.fn().mockResolvedValue(undefined),
    revokePrevious: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('SecretRotationService', () => {
  test('rotates due secrets through canary promotion and clears cache', async () => {
    let now = 2000;
    const secretsService = { clearCache: jest.fn() };
    const auditLogger = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new SecretRotationService({ secretsService, auditLogger, clock: { now: () => now } });
    const config = buildConfig({ generate: jest.fn().mockResolvedValue('new-secret') });

    service.registerSecret(config);
    const result = await service.rotateSecret('database/password');

    expect(result.status).toBe('rotated');
    expect(config.writeCandidate).toHaveBeenCalledWith(expect.objectContaining({ value: 'new-secret' }), expect.objectContaining({ blueGreen: true, percent: 10 }));
    expect(config.validateCandidate).toHaveBeenCalled();
    expect(config.promoteCandidate).toHaveBeenCalled();
    expect(config.revokePrevious).toHaveBeenCalled();
    expect(secretsService.clearCache).toHaveBeenCalled();
    expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'secret.rotation.completed' }));
  });

  test('lists only secrets whose rotation interval elapsed', () => {
    const service = new SecretRotationService({ secretsService: { clearCache: jest.fn() }, auditLogger: { log: jest.fn() }, clock: { now: () => 5000 } });
    service.registerSecret(buildConfig({ name: 'api/stellar_key', lastRotatedAt: 4500, rotationIntervalMs: 1000 }));
    service.registerSecret(buildConfig({ name: 'api/discord_token', lastRotatedAt: 3000, rotationIntervalMs: 1000 }));

    expect(service.listSecretsDueForRotation(5000).map((secret) => secret.name)).toEqual(['api/discord_token']);
  });

  test('records failure without clearing cache when validation fails', async () => {
    const secretsService = { clearCache: jest.fn() };
    const auditLogger = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new SecretRotationService({ secretsService, auditLogger, clock: { now: () => 3000 } });
    service.registerSecret(buildConfig({ validateCandidate: jest.fn().mockRejectedValue(new Error('candidate rejected')) }));

    await expect(service.rotateSecret('database/password')).rejects.toThrow('candidate rejected');
    expect(secretsService.clearCache).not.toHaveBeenCalled();
    expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'secret.rotation.failed' }));
  });
});
