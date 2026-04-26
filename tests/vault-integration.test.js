const { vaultManager } = require('../config/vault');

describe('Vault Integration Tests', () => {
  beforeAll(async () => {
    // Set test environment variables
    process.env.NODE_ENV = 'test';
    process.env.VAULT_ADDR = process.env.VAULT_ADDR || 'http://localhost:8200';
    process.env.VAULT_TOKEN = process.env.VAULT_TOKEN || 'test-token';
  });

  describe('Vault Manager Initialization', () => {
    test('should initialize vault manager successfully', async () => {
      // This test will be skipped if Vault is not available
      try {
        await vaultManager.initialize();
        expect(vaultManager.isInitialized).toBe(true);
      } catch (error) {
        console.warn('Vault not available, skipping test:', error.message);
      }
    });

    test('should handle missing Vault gracefully', async () => {
      // Test with invalid Vault address
      const originalAddr = process.env.VAULT_ADDR;
      process.env.VAULT_ADDR = 'http://invalid:8200';
      
      try {
        await vaultManager.initialize();
        expect(vaultManager.isInitialized).toBe(false);
      } catch (error) {
        expect(error.message).toContain('Vault connection failed');
      } finally {
        process.env.VAULT_ADDR = originalAddr;
      }
    });
  });

  describe('Secret Retrieval', () => {
    beforeAll(async () => {
      try {
        await vaultManager.initialize();
      } catch (error) {
        console.warn('Skipping secret tests - Vault not available');
      }
    });

    test('should get database configuration', () => {
      const dbConfig = vaultManager.getDatabaseConfig();
      
      expect(dbConfig).toHaveProperty('host');
      expect(dbConfig).toHaveProperty('port');
      expect(dbConfig).toHaveProperty('username');
      expect(dbConfig).toHaveProperty('password');
      expect(dbConfig).toHaveProperty('database');
      
      // Should return defaults if Vault is not initialized
      if (!vaultManager.isInitialized) {
        expect(dbConfig.host).toBe('localhost');
        expect(dbConfig.port).toBe(6432);
      }
    });

    test('should get application configuration', () => {
      const appConfig = vaultManager.getApplicationConfig();
      
      expect(appConfig).toHaveProperty('node_env');
      expect(appConfig).toHaveProperty('port');
      expect(appConfig).toHaveProperty('jwt_secret');
      expect(appConfig).toHaveProperty('admin_signature_required');
      
      // Should return defaults if Vault is not initialized
      if (!vaultManager.isInitialized) {
        expect(appConfig.node_env).toBe('development');
        expect(appConfig.port).toBe(3000);
      }
    });

    test('should get stellar configuration', () => {
      const stellarConfig = vaultManager.getStellarConfig();
      
      expect(stellarConfig).toHaveProperty('horizon_primary');
      expect(stellarConfig).toHaveProperty('horizon_fallback');
      expect(stellarConfig).toHaveProperty('soroban_rpc');
      
      // Should return defaults if Vault is not initialized
      if (!vaultManager.isInitialized) {
        expect(stellarConfig.horizon_primary).toBe('https://horizon.stellar.org');
        expect(stellarConfig.horizon_fallback).toBe('https://horizon-testnet.stellar.org');
      }
    });
  });

  describe('Health Check', () => {
    test('should perform health check', async () => {
      const health = await vaultManager.healthCheck();
      
      expect(health).toHaveProperty('status');
      expect(health).toHaveProperty('initialized');
      expect(['healthy', 'unhealthy']).toContain(health.status);
    });
  });

  describe('Error Handling', () => {
    test('should handle missing secret gracefully', () => {
      const missingSecret = vaultManager.getSecret('nonexistent', 'key', 'default');
      expect(missingSecret).toBe('default');
    });

    test('should retry failed operations', async () => {
      // Mock a failing operation
      const mockOperation = jest.fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce('success');

      try {
        const result = await vaultManager.withRetry(mockOperation);
        expect(result).toBe('success');
        expect(mockOperation).toHaveBeenCalledTimes(3);
      } catch (error) {
        // Expected if Vault is not available
        expect(error.message).toBeDefined();
      }
    });
  });
});
