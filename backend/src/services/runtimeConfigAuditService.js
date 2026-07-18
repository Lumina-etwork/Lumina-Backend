const crypto = require('crypto');

const DEFAULT_CRITICAL_KEYS = [
  'NODE_ENV',
  'PORT',
  'DATABASE_URL',
  'REDIS_URL',
  'SOROBAN_RPC_URL',
  'SOROBAN_NETWORK_PASSPHRASE',
  'SOROBAN_CONTRACT_ADDRESSES',
  'JWT_SECRET',
  'SENTRY_DSN',
  'CONFIG_AUDIT_EXPECTED_HASH',
];

const DEFAULT_SENSITIVE_PATTERNS = [
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /PRIVATE/i,
  /KEY/i,
  /DSN/i,
  /DATABASE_URL/i,
  /REDIS_URL/i,
];

class RuntimeConfigAuditService {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.clock = options.clock || (() => new Date());
    this.criticalKeys = this.parseList(
      options.criticalKeys || this.env.CONFIG_AUDIT_KEYS,
      DEFAULT_CRITICAL_KEYS,
    );
    this.sensitivePatterns = options.sensitivePatterns || DEFAULT_SENSITIVE_PATTERNS;
    this.expectedHash = options.expectedHash || this.env.CONFIG_AUDIT_EXPECTED_HASH || null;
    this.logger = options.logger || console;
    this.metrics = options.metrics || null;
    this.baseline = options.baseline || null;
    this.lastAudit = null;
  }

  parseList(value, fallback) {
    if (Array.isArray(value)) {
      return value.filter(Boolean);
    }
    if (typeof value === 'string' && value.trim()) {
      return value.split(',').map((item) => item.trim()).filter(Boolean);
    }
    return [...fallback];
  }

  maskValue(key, value) {
    if (value === undefined) {
      return null;
    }
    const stringValue = String(value);
    if (this.sensitivePatterns.some((pattern) => pattern.test(key))) {
      return {
        redacted: true,
        present: stringValue.length > 0,
        length: stringValue.length,
        sha256: this.hash(stringValue),
      };
    }
    return stringValue;
  }

  hash(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
  }

  buildSnapshot() {
    const entries = this.criticalKeys
      .slice()
      .sort()
      .map((key) => [key, this.env[key] === undefined ? null : String(this.env[key])]);

    const normalized = Object.fromEntries(entries);
    const redacted = Object.fromEntries(
      entries.map(([key, value]) => [key, this.maskValue(key, value)]),
    );

    return {
      generatedAt: this.clock().toISOString(),
      keys: this.criticalKeys.slice().sort(),
      values: redacted,
      hash: this.hash(JSON.stringify(normalized)),
    };
  }

  diffSnapshots(current, baseline) {
    if (!baseline) {
      return [];
    }
    const drift = [];
    const keys = new Set([...Object.keys(current.values), ...Object.keys(baseline.values || {})]);
    for (const key of [...keys].sort()) {
      const currentValue = JSON.stringify(current.values[key] ?? null);
      const baselineValue = JSON.stringify((baseline.values || {})[key] ?? null);
      if (currentValue !== baselineValue) {
        drift.push({ key, current: current.values[key] ?? null, baseline: (baseline.values || {})[key] ?? null });
      }
    }
    return drift;
  }

  audit(options = {}) {
    const start = process.hrtime.bigint();
    const snapshot = this.buildSnapshot();
    const baseline = options.baseline || this.baseline;
    const drift = this.diffSnapshots(snapshot, baseline);
    const expectedHash = options.expectedHash || this.expectedHash;
    const hashMatches = expectedHash ? snapshot.hash === expectedHash : null;
    const status = drift.length === 0 && hashMatches !== false ? 'healthy' : 'drift_detected';
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

    const result = {
      status,
      durationMs,
      snapshot,
      drift,
      expectedHashConfigured: Boolean(expectedHash),
      hashMatches,
    };

    this.lastAudit = result;
    if (this.metrics) {
      this.metrics.configAuditDuration.observe(durationMs / 1000);
      this.metrics.configDriftKeys.set(drift.length);
      this.metrics.configAuditStatus.set({ status: 'healthy' }, status === 'healthy' ? 1 : 0);
      this.metrics.configAuditStatus.set({ status: 'drift_detected' }, status === 'drift_detected' ? 1 : 0);
      if (status !== 'healthy') {
        this.metrics.configDriftDetected.inc();
      }
    }
    return result;
  }

  setBaseline(snapshot = this.buildSnapshot()) {
    this.baseline = snapshot;
    return this.baseline;
  }

  getLastAudit() {
    return this.lastAudit;
  }
}

module.exports = { RuntimeConfigAuditService, DEFAULT_CRITICAL_KEYS };
