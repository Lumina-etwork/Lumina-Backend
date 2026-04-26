const { Horizon, SorobanRpc } = require('stellar-sdk');

class StellarService {
  constructor() {
    this.endpoints = {
      primary: process.env.STELLAR_HORIZON_PRIMARY || 'https://horizon.stellar.org',
      fallback: process.env.STELLAR_HORIZON_FALLBACK || 'https://horizon-testnet.stellar.org',
      soroban: process.env.STELLAR_SOROBAN_RPC || 'https://soroban-rpc.stellar.org'
    };
    
    this.currentEndpoint = this.endpoints.primary;
    this.lastFailureTime = null;
    this.failureCount = 0;
    this.maxRetries = 3;
    this.backoffMs = 1000;
    
    // Circuit breaker pattern
    this.circuitBreaker = {
      primary: {
        failures: 0,
        lastFailureTime: null,
        state: 'CLOSED', // CLOSED, OPEN, HALF_OPEN
        threshold: 5,
        timeout: 60000 // 1 minute
      },
      fallback: {
        failures: 0,
        lastFailureTime: null,
        state: 'CLOSED',
        threshold: 3,
        timeout: 30000 // 30 seconds
      }
    };
    
    // Rate limit tracking
    this.rateLimitTracker = {
      primary: {
        requests: [],
        limit: null,
        remaining: null,
        resetTime: null
      },
      fallback: {
        requests: [],
        limit: null,
        remaining: null,
        resetTime: null
      }
    };
    
    this.servers = {
      primary: new Horizon.Server(this.endpoints.primary),
      fallback: new Horizon.Server(this.endpoints.fallback),
      soroban: new SorobanRpc.Server(this.endpoints.soroban)
    };
  }

  async makeRequest(requestFn, endpoint = 'primary') {
    let lastError;
    
    // Check circuit breaker
    if (!this.isEndpointAvailable(endpoint)) {
      console.warn(`Endpoint ${endpoint} is in OPEN state, trying fallback`);
      if (endpoint === 'primary') {
        return this.makeRequest(requestFn, 'fallback');
      } else {
        throw new Error('Both primary and fallback endpoints are unavailable');
      }
    }
    
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const result = await requestFn(this.servers[endpoint]);
        
        // Reset failure count on success
        this.resetCircuitBreaker(endpoint);
        this.updateRateLimitInfo(endpoint, result.response?.headers);
        
        return result;
      } catch (error) {
        lastError = error;
        this.recordFailure(endpoint);
        
        // Check if it's a rate limit error
        if (error.response?.status === 429) {
          console.warn(`Rate limit hit on ${endpoint}, attempt ${attempt + 1}/${this.maxRetries}`);
          this.handleRateLimit(endpoint, error.response.headers);
          
          if (endpoint === 'primary' && attempt === this.maxRetries - 1) {
            console.log('Switching to fallback endpoint due to rate limits');
            return this.makeRequest(requestFn, 'fallback');
          }
          
          // Exponential backoff with jitter
          const backoffTime = this.calculateBackoff(attempt);
          await this.delay(backoffTime);
          continue;
        }
        
        // For other errors, try fallback if primary fails
        if (endpoint === 'primary' && this.shouldUseFallback(error)) {
          console.log(`Primary endpoint failed, switching to fallback: ${error.message}`);
          return this.makeRequest(requestFn, 'fallback');
        }
        
        throw error;
      }
    }
    
    throw lastError;
  }

  shouldUseFallback(error) {
    // Use fallback for network errors, timeouts, or server errors
    return (
      error.code === 'ECONNREFUSED' ||
      error.code === 'ETIMEDOUT' ||
      error.response?.status >= 500 ||
      error.message.includes('timeout')
    );
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Circuit breaker methods
  isEndpointAvailable(endpoint) {
    const breaker = this.circuitBreaker[endpoint];
    const now = Date.now();
    
    if (breaker.state === 'OPEN') {
      if (now - breaker.lastFailureTime > breaker.timeout) {
        breaker.state = 'HALF_OPEN';
        console.log(`Circuit breaker for ${endpoint} entering HALF_OPEN state`);
        return true;
      }
      return false;
    }
    
    return true;
  }

  recordFailure(endpoint) {
    const breaker = this.circuitBreaker[endpoint];
    breaker.failures++;
    breaker.lastFailureTime = Date.now();
    
    if (breaker.failures >= breaker.threshold) {
      breaker.state = 'OPEN';
      console.log(`Circuit breaker for ${endpoint} OPENED after ${breaker.failures} failures`);
    }
  }

  resetCircuitBreaker(endpoint) {
    const breaker = this.circuitBreaker[endpoint];
    if (breaker.state !== 'CLOSED') {
      console.log(`Circuit breaker for ${endpoint} CLOSED`);
    }
    breaker.failures = 0;
    breaker.state = 'CLOSED';
    breaker.lastFailureTime = null;
  }

  // Rate limit handling
  handleRateLimit(endpoint, headers) {
    const tracker = this.rateLimitTracker[endpoint];
    const limit = headers?.['x-ratelimit-limit'];
    const remaining = headers?.['x-ratelimit-remaining'];
    const reset = headers?.['x-ratelimit-reset'];
    
    if (limit) tracker.limit = parseInt(limit);
    if (remaining) tracker.remaining = parseInt(remaining);
    if (reset) tracker.resetTime = new Date(parseInt(reset) * 1000);
    
    console.warn(`Rate limit info for ${endpoint}: ${tracker.remaining}/${tracker.limit} remaining`);
  }

  updateRateLimitInfo(endpoint, headers) {
    const tracker = this.rateLimitTracker[endpoint];
    const now = Date.now();
    
    // Track request timestamp
    tracker.requests.push(now);
    
    // Clean old requests (older than 1 hour)
    const oneHourAgo = now - 3600000;
    tracker.requests = tracker.requests.filter(timestamp => timestamp > oneHourAgo);
    
    // Update rate limit info if available
    if (headers) {
      this.handleRateLimit(endpoint, headers);
    }
  }

  calculateBackoff(attempt) {
    // Exponential backoff with jitter
    const baseDelay = this.backoffMs * Math.pow(2, attempt);
    const jitter = Math.random() * 0.1 * baseDelay; // 10% jitter
    return baseDelay + jitter;
  }

  // Stellar Horizon API methods with fallback
  async getAccount(accountId) {
    return this.makeRequest(server => server.loadAccount(accountId));
  }

  async getTransaction(txHash) {
    return this.makeRequest(server => server.transactions().transaction(txHash));
  }

  async submitTransaction(transaction) {
    return this.makeRequest(server => server.submitTransaction(transaction));
  }

  async getOperations(options = {}) {
    return this.makeRequest(server => 
      server.operations()
        .limit(options.limit || 10)
        .order(options.order || 'desc')
        .call()
    );
  }

  async getLedgers(options = {}) {
    return this.makeRequest(server => 
      server.ledgers()
        .limit(options.limit || 10)
        .order(options.order || 'desc')
        .call()
    );
  }

  // Soroban RPC methods
  async getAccountBalance(accountId) {
    try {
      return await this.servers.soroban.getBalance(accountId);
    } catch (error) {
      console.warn('Soroban RPC failed, falling back to Horizon:', error.message);
      const account = await this.getAccount(accountId);
      return account.balances;
    }
  }

  async simulateTransaction(transaction) {
    return this.servers.soroban.simulateTransaction(transaction);
  }

  // Health check and fallback testing
  async testFallback() {
    console.log('Testing Stellar service fallback mechanism...');
    
    try {
      // Test primary endpoint
      await this.getLedgers({ limit: 1 });
      console.log('✓ Primary Horizon endpoint is healthy');
    } catch (error) {
      console.warn('⚠ Primary Horizon endpoint failed:', error.message);
      
      try {
        // Test fallback endpoint
        await this.makeRequest(server => server.ledgers().limit(1).call(), 'fallback');
        console.log('✓ Fallback Horizon endpoint is healthy');
      } catch (fallbackError) {
        console.error('✗ Fallback Horizon endpoint also failed:', fallbackError.message);
        throw new Error('All Stellar endpoints are unavailable');
      }
    }
    
    try {
      // Test Soroban RPC
      await this.servers.soroban.getLatestLedger();
      console.log('✓ Soroban RPC endpoint is healthy');
    } catch (error) {
      console.warn('⚠ Soroban RPC endpoint failed:', error.message);
    }
    
    console.log('Stellar service fallback mechanism test completed');
  }

  // Get current status of all endpoints
  getEndpointStatus() {
    return {
      endpoints: this.endpoints,
      circuitBreaker: this.circuitBreaker,
      rateLimitTracker: this.rateLimitTracker,
      current: this.currentEndpoint,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime
    };
  }

  // Get detailed endpoint health
  async getEndpointHealth() {
    const health = {
      primary: { status: 'unknown', responseTime: null },
      fallback: { status: 'unknown', responseTime: null },
      soroban: { status: 'unknown', responseTime: null }
    };

    // Test primary endpoint
    try {
      const start = Date.now();
      await this.makeRequest(server => server.ledgers().limit(1).call(), 'primary');
      health.primary = {
        status: 'healthy',
        responseTime: Date.now() - start
      };
    } catch (error) {
      health.primary = {
        status: 'unhealthy',
        error: error.message
      };
    }

    // Test fallback endpoint
    try {
      const start = Date.now();
      await this.makeRequest(server => server.ledgers().limit(1).call(), 'fallback');
      health.fallback = {
        status: 'healthy',
        responseTime: Date.now() - start
      };
    } catch (error) {
      health.fallback = {
        status: 'unhealthy',
        error: error.message
      };
    }

    // Test Soroban RPC
    try {
      const start = Date.now();
      await this.servers.soroban.getLatestLedger();
      health.soroban = {
        status: 'healthy',
        responseTime: Date.now() - start
      };
    } catch (error) {
      health.soroban = {
        status: 'unhealthy',
        error: error.message
      };
    }

    return health;
  }
}

module.exports = new StellarService();
