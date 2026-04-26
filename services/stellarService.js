const { Horizon, SorobanRpc } = require('stellar-sdk');
const axios = require('axios');

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
    
    this.servers = {
      primary: new Horizon.Server(this.endpoints.primary),
      fallback: new Horizon.Server(this.endpoints.fallback),
      soroban: new SorobanRpc.Server(this.endpoints.soroban)
    };
  }

  async makeRequest(requestFn, endpoint = 'primary') {
    let lastError;
    
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const result = await requestFn(this.servers[endpoint]);
        
        // Reset failure count on success
        if (endpoint === 'primary') {
          this.failureCount = 0;
          this.lastFailureTime = null;
        }
        
        return result;
      } catch (error) {
        lastError = error;
        
        // Check if it's a rate limit error
        if (error.response?.status === 429) {
          console.warn(`Rate limit hit on ${endpoint}, attempt ${attempt + 1}/${this.maxRetries}`);
          
          if (endpoint === 'primary' && attempt === this.maxRetries - 1) {
            console.log('Switching to fallback endpoint due to rate limits');
            return this.makeRequest(requestFn, 'fallback');
          }
          
          // Exponential backoff
          await this.delay(this.backoffMs * Math.pow(2, attempt));
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
      primary: this.endpoints.primary,
      fallback: this.endpoints.fallback,
      soroban: this.endpoints.soroban,
      current: this.currentEndpoint,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime
    };
  }
}

module.exports = new StellarService();
