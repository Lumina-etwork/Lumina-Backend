const { tenantTokenBucketRateLimiter } = require('../services/tenantTokenBucketRateLimiter');
const metricsService = require('../services/metricsService');

const tenantRateLimitMiddleware = (limiter = tenantTokenBucketRateLimiter) => (req, res, next) => {
  const result = limiter.checkRequest(req);

  res.set({
    'X-RateLimit-Limit': result.limit,
    'X-RateLimit-Remaining': result.remaining,
    'X-RateLimit-Reset': new Date(result.resetTime).toISOString(),
    'X-RateLimit-Policy': `token-bucket;tenant;policy=${result.policyName}`,
  });

  if (metricsService.tenantRateLimitDecisions) {
    metricsService.tenantRateLimitDecisions.inc({ tenant_id: result.tenantId, decision: result.allowed ? 'allowed' : 'blocked' });
  }

  if (!result.allowed) {
    res.set('Retry-After', result.retryAfter);
    return res.status(429).json({
      success: false,
      error: 'TENANT_RATE_LIMIT_EXCEEDED',
      message: 'Too many requests for this tenant. Please try again later.',
      rateLimitInfo: result,
    });
  }

  req.tenantRateLimit = result;
  return next();
};

module.exports = { tenantRateLimitMiddleware };
