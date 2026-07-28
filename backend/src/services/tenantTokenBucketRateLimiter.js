const crypto = require('crypto');

const DEFAULT_LIMIT = Number(process.env.TENANT_RATE_LIMIT_CAPACITY || 600);
const DEFAULT_REFILL_PER_SECOND = Number(process.env.TENANT_RATE_LIMIT_REFILL_PER_SECOND || 10);
const DEFAULT_AUTH_LIMIT = Number(process.env.TENANT_AUTH_RATE_LIMIT_CAPACITY || 60);
const DEFAULT_AUTH_REFILL_PER_SECOND = Number(process.env.TENANT_AUTH_RATE_LIMIT_REFILL_PER_SECOND || 1);
const MAX_IDLE_BUCKETS = Number(process.env.TENANT_RATE_LIMIT_MAX_BUCKETS || 50000);

class TenantTokenBucketRateLimiter {
  constructor(options = {}) {
    this.clock = options.clock || (() => Date.now());
    this.buckets = new Map();
    this.maxIdleBuckets = options.maxIdleBuckets || MAX_IDLE_BUCKETS;
    this.defaultPolicy = options.defaultPolicy || {
      capacity: DEFAULT_LIMIT,
      refillPerSecond: DEFAULT_REFILL_PER_SECOND,
    };
    this.authPolicy = options.authPolicy || {
      capacity: DEFAULT_AUTH_LIMIT,
      refillPerSecond: DEFAULT_AUTH_REFILL_PER_SECOND,
    };
  }

  getPolicy(req = {}) {
    if (req.path && req.path.startsWith('/api/auth')) {
      return this.authPolicy;
    }
    return this.defaultPolicy;
  }

  getTenantId(req = {}) {
    const explicitTenant = req.headers?.['x-tenant-id'] || req.headers?.['x-organization-id'];
    const apiKeyTenant = req.apiKey?.tenantId || req.apiKey?.organizationId;
    const userTenant = req.user?.tenantId || req.user?.organization_id || req.user?.organizationId;
    const tenantId = explicitTenant || apiKeyTenant || userTenant || 'anonymous';
    return String(tenantId).trim().toLowerCase() || 'anonymous';
  }

  bucketKey(tenantId, policyName) {
    const hash = crypto.createHash('sha256').update(tenantId).digest('hex').slice(0, 16);
    return `${policyName}:${hash}`;
  }

  consume({ tenantId, policy, policyName = 'default', cost = 1 }) {
    const now = this.clock();
    const key = this.bucketKey(tenantId, policyName);
    const capacity = Math.max(1, Number(policy.capacity));
    const refillPerSecond = Math.max(0.001, Number(policy.refillPerSecond));
    const existing = this.buckets.get(key) || { tokens: capacity, updatedAt: now };
    const elapsedSeconds = Math.max(0, (now - existing.updatedAt) / 1000);
    const tokens = Math.min(capacity, existing.tokens + elapsedSeconds * refillPerSecond);
    const allowed = tokens >= cost;
    const remaining = allowed ? tokens - cost : tokens;
    const resetInMs = Math.ceil(((capacity - remaining) / refillPerSecond) * 1000);
    const retryAfterMs = allowed ? 0 : Math.ceil(((cost - remaining) / refillPerSecond) * 1000);

    this.buckets.set(key, { tokens: remaining, updatedAt: now, lastSeenAt: now });
    this.pruneIfNeeded(now);

    return {
      allowed,
      limit: capacity,
      remaining: Math.floor(remaining),
      resetTime: now + resetInMs,
      retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      tenantId,
      policyName,
    };
  }

  checkRequest(req, cost = 1) {
    const policy = this.getPolicy(req);
    const policyName = req.path && req.path.startsWith('/api/auth') ? 'auth' : 'default';
    return this.consume({ tenantId: this.getTenantId(req), policy, policyName, cost });
  }

  pruneIfNeeded(now) {
    if (this.buckets.size <= this.maxIdleBuckets) return;
    const entries = [...this.buckets.entries()].sort((a, b) => (a[1].lastSeenAt || 0) - (b[1].lastSeenAt || 0));
    for (const [key] of entries.slice(0, Math.ceil(this.maxIdleBuckets * 0.1))) {
      this.buckets.delete(key);
    }
  }

  reset() {
    this.buckets.clear();
  }
}

module.exports = {
  TenantTokenBucketRateLimiter,
  tenantTokenBucketRateLimiter: new TenantTokenBucketRateLimiter(),
};
