const { TenantTokenBucketRateLimiter } = require('../services/tenantTokenBucketRateLimiter');
const { tenantRateLimitMiddleware } = require('../middleware/tenantRateLimit.middleware');

describe('TenantTokenBucketRateLimiter', () => {
  test('isolates token buckets per tenant', () => {
    let now = 0;
    const limiter = new TenantTokenBucketRateLimiter({
      clock: () => now,
      defaultPolicy: { capacity: 2, refillPerSecond: 1 },
    });

    expect(limiter.checkRequest({ path: '/api/vaults', headers: { 'x-tenant-id': 'alpha' } }).allowed).toBe(true);
    expect(limiter.checkRequest({ path: '/api/vaults', headers: { 'x-tenant-id': 'alpha' } }).allowed).toBe(true);
    expect(limiter.checkRequest({ path: '/api/vaults', headers: { 'x-tenant-id': 'alpha' } }).allowed).toBe(false);
    expect(limiter.checkRequest({ path: '/api/vaults', headers: { 'x-tenant-id': 'beta' } }).allowed).toBe(true);

    now = 1000;
    expect(limiter.checkRequest({ path: '/api/vaults', headers: { 'x-tenant-id': 'alpha' } }).allowed).toBe(true);
  });

  test('uses stricter auth policy for auth endpoints', () => {
    const limiter = new TenantTokenBucketRateLimiter({
      clock: () => 0,
      defaultPolicy: { capacity: 10, refillPerSecond: 10 },
      authPolicy: { capacity: 1, refillPerSecond: 1 },
    });

    expect(limiter.checkRequest({ path: '/api/auth/login', headers: { 'x-tenant-id': 'alpha' } }).allowed).toBe(true);
    expect(limiter.checkRequest({ path: '/api/auth/login', headers: { 'x-tenant-id': 'alpha' } }).allowed).toBe(false);
  });
});

describe('tenantRateLimitMiddleware', () => {
  test('returns 429 and Retry-After when tenant bucket is exhausted', () => {
    const limiter = new TenantTokenBucketRateLimiter({
      clock: () => 0,
      defaultPolicy: { capacity: 1, refillPerSecond: 1 },
    });
    const middleware = tenantRateLimitMiddleware(limiter);
    const req = { path: '/api/vaults', headers: { 'x-tenant-id': 'alpha' } };
    const res = { headers: {}, statusCode: 200, set(values, value) { typeof values === 'string' ? this.headers[values] = value : Object.assign(this.headers, values); return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };

    middleware(req, res, () => {});
    middleware(req, res, () => {});

    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe(1);
    expect(res.body.error).toBe('TENANT_RATE_LIMIT_EXCEEDED');
  });
});
