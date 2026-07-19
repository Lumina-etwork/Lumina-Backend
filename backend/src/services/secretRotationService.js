const crypto = require('crypto');
const metrics = require('./metricsService');

const DEFAULT_ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CANARY_PERCENT = 10;
const DEFAULT_P99_TARGET_MS = 100;

class SecretRotationService {
  constructor({ secretsService, auditLogger, clock, logger } = {}) {
    this.secretsService = secretsService || require('./secretsService');
    this.auditLogger = auditLogger || require('./auditLogger');
    this.clock = clock || { now: () => Date.now() };
    this.logger = logger || console;
    this.registry = new Map();
    this.rotationLocks = new Set();
  }

  registerSecret(config) {
    const normalized = this.validateConfig(config);
    this.registry.set(normalized.name, normalized);
    return normalized;
  }

  registerMany(configs = []) {
    return configs.map((config) => this.registerSecret(config));
  }

  listSecretsDueForRotation(now = this.clock.now()) {
    return [...this.registry.values()].filter((secret) => {
      const lastRotatedAt = secret.lastRotatedAt || 0;
      return now - lastRotatedAt >= secret.rotationIntervalMs;
    });
  }

  async rotateDueSecrets({ now = this.clock.now(), dryRun = false } = {}) {
    const dueSecrets = this.listSecretsDueForRotation(now);
    const results = [];

    for (const secret of dueSecrets) {
      results.push(await this.rotateSecret(secret.name, { now, dryRun }));
    }

    return results;
  }

  async rotateSecret(name, { now = this.clock.now(), dryRun = false } = {}) {
    const config = this.registry.get(name);
    if (!config) {
      throw new Error(`Secret rotation config not found: ${name}`);
    }

    if (this.rotationLocks.has(name)) {
      return { name, status: 'skipped', reason: 'rotation_already_in_progress' };
    }

    const start = this.clock.now();
    this.rotationLocks.add(name);
    metrics.secretRotationAttempts.inc({ secret_type: config.type, provider: config.provider });

    try {
      const candidate = await this.generateCandidateSecret(config);
      const canary = this.buildCanaryPlan(config, candidate);

      if (!dryRun) {
        await config.writeCandidate(candidate, canary);
        await config.validateCandidate(candidate, canary);
        await config.promoteCandidate(candidate, canary);
        if (typeof config.revokePrevious === 'function') {
          await config.revokePrevious(config.currentVersion, candidate);
        }
      }

      config.lastRotatedAt = now;
      config.currentVersion = candidate.version;
      this.secretsService.clearCache();

      const durationMs = Math.max(0, this.clock.now() - start);
      metrics.secretRotationDuration.observe({ secret_type: config.type, provider: config.provider }, durationMs / 1000);
      metrics.secretRotationStatus.set({ secret_type: config.type, provider: config.provider }, 1);

      await this.writeAuditLog('secret.rotation.completed', config, {
        dryRun,
        version: candidate.version,
        durationMs,
        canaryPercent: canary.percent,
      });

      return { name, status: dryRun ? 'dry_run' : 'rotated', version: candidate.version, durationMs };
    } catch (error) {
      metrics.secretRotationFailures.inc({ secret_type: config.type, provider: config.provider });
      metrics.secretRotationStatus.set({ secret_type: config.type, provider: config.provider }, 0);
      await this.writeAuditLog('secret.rotation.failed', config, { error: error.message });
      throw error;
    } finally {
      this.rotationLocks.delete(name);
    }
  }

  buildCanaryPlan(config, candidate) {
    return {
      percent: config.canaryPercent,
      candidateVersion: candidate.version,
      p99TargetMs: config.p99TargetMs,
      analysisWindowMs: config.canaryAnalysisWindowMs,
      blueGreen: true,
    };
  }

  async generateCandidateSecret(config) {
    const value = typeof config.generate === 'function'
      ? await config.generate(config)
      : crypto.randomBytes(config.byteLength).toString('base64url');

    return {
      name: config.name,
      type: config.type,
      value,
      version: `${this.clock.now()}-${crypto.randomBytes(6).toString('hex')}`,
      createdAt: new Date(this.clock.now()).toISOString(),
    };
  }

  validateConfig(config = {}) {
    const required = ['name', 'type', 'provider', 'writeCandidate', 'validateCandidate', 'promoteCandidate'];
    for (const field of required) {
      if (!config[field]) {
        throw new Error(`Missing required secret rotation config field: ${field}`);
      }
    }

    return {
      rotationIntervalMs: DEFAULT_ROTATION_INTERVAL_MS,
      canaryPercent: DEFAULT_CANARY_PERCENT,
      p99TargetMs: DEFAULT_P99_TARGET_MS,
      canaryAnalysisWindowMs: 5 * 60 * 1000,
      byteLength: 48,
      lastRotatedAt: 0,
      currentVersion: null,
      ...config,
    };
  }

  async writeAuditLog(event, config, payload) {
    if (!this.auditLogger || typeof this.auditLogger.log !== 'function') {
      this.logger.info(event, { secret: config.name, ...payload });
      return;
    }

    await this.auditLogger.log({
      action: event,
      resourceType: 'secret',
      resourceId: config.name,
      metadata: {
        type: config.type,
        provider: config.provider,
        ...payload,
      },
    });
  }
}

module.exports = SecretRotationService;
