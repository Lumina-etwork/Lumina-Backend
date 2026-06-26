const { sequelize } = require('../database/connection');
const IdempotencyKeyService = require('./idempotencyKeyService');
const { IdempotencyKey } = require('../models');

describe('IdempotencyKeyService', () => {
  let service;

  beforeAll(async () => {
    // Sync database for testing - SQLite in-memory for NODE_ENV=test
    await sequelize.sync({ force: true });
    service = IdempotencyKeyService;
  });

  afterAll(async () => {
    await sequelize.close();
  });

  beforeEach(async () => {
    // Clean up before each test
    await IdempotencyKey.destroy({ where: {} });
  });

  describe('generateIdempotencyKey', () => {
    it('should generate a consistent key for the same inputs', () => {
      const webhookType = 'claim';
      const targetEndpoint = 'https://example.com/webhook';
      const payload = { event: 'test', data: 'value' };

      const key1 = service.generateIdempotencyKey(webhookType, targetEndpoint, payload);
      const key2 = service.generateIdempotencyKey(webhookType, targetEndpoint, payload);

      expect(key1).toBe(key2);
      expect(key1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should generate different keys for different inputs', () => {
      const webhookType = 'claim';
      const targetEndpoint = 'https://example.com/webhook';
      const payload1 = { event: 'test', data: 'value1' };
      const payload2 = { event: 'test', data: 'value2' };

      const key1 = service.generateIdempotencyKey(webhookType, targetEndpoint, payload1);
      const key2 = service.generateIdempotencyKey(webhookType, targetEndpoint, payload2);

      expect(key1).not.toBe(key2);
    });

    it('should use provided key when given', () => {
      const providedKey = 'custom-key-123';
      const key = service.generateIdempotencyKey('claim', 'https://example.com', { event: 'test' }, providedKey);
      expect(key).toBe(providedKey);
    });
  });

  describe('createPayloadHash', () => {
    it('should generate consistent hash for same payload regardless of key order', () => {
      const hash1 = service.createPayloadHash({ b: 2, a: 1 });
      const hash2 = service.createPayloadHash({ a: 1, b: 2 });
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('checkIdempotencyKey', () => {
    it('should return null for non-existent key', async () => {
      const result = await service.checkIdempotencyKey('non-existent-key');
      expect(result).toBeNull();
    });

    it('should return null for expired key', async () => {
      const key = 'test-key-expired';
      await service.createIdempotencyKey(key, 'claim', 'https://example.com', {}, -1);
      const result = await service.checkIdempotencyKey(key);
      expect(result).toBeNull();
    });

    it('should return record for valid existing key', async () => {
      const key = 'test-key-valid';
      await service.createIdempotencyKey(key, 'claim', 'https://example.com', {});
      const result = await service.checkIdempotencyKey(key);
      expect(result).not.toBeNull();
      expect(result.key).toBe(key);
      expect(result.webhook_type).toBe('claim');
    });
  });

  describe('createIdempotencyKey', () => {
    it('should create new idempotency key record', async () => {
      const key = 'test-key-create';
      const record = await service.createIdempotencyKey(key, 'claim', 'https://example.com', { event: 'test' });
      expect(record).not.toBeNull();
      expect(record.key).toBe(key);
      expect(record.webhook_type).toBe('claim');
      expect(record.status).toBe('pending');
    });

    it('should return existing record if key already exists', async () => {
      const key = 'test-key-exists';
      const record1 = await service.createIdempotencyKey(key, 'claim', 'https://example.com', { event: 'test' });
      const record2 = await service.createIdempotencyKey(key, 'claim', 'https://example.com', { event: 'test' });
      expect(record1.id).toBe(record2.id);
    });

    it('should throw error if key exists but payload differs', async () => {
      const key = 'test-key-diff';
      await service.createIdempotencyKey(key, 'claim', 'https://example.com', { event: 'test1' });
      await expect(
        service.createIdempotencyKey(key, 'claim', 'https://example.com', { event: 'test2' })
      ).rejects.toThrow('Idempotency key exists but payload does not match');
    });
  });

  describe('markAsProcessing', () => {
    it('should update status to processing', async () => {
      const key = 'test-key-proc';
      await service.createIdempotencyKey(key, 'claim', 'https://example.com', {});
      const result = await service.markAsProcessing(key);
      expect(result).toBe(true);
    });

    it('should return false for non-existent key', async () => {
      const result = await service.markAsProcessing('non-existent-key');
      expect(result).toBe(false);
    });
  });

  describe('markAsCompleted', () => {
    it('should update status to completed with response details', async () => {
      const key = 'test-key-completed';
      await service.createIdempotencyKey(key, 'claim', 'https://example.com', {});
      const result = await service.markAsCompleted(key, 200, 'Success response');
      expect(result).toBe(true);
    });
  });

  describe('markAsFailed', () => {
    it('should update status to failed with error message', async () => {
      const key = 'test-key-failed';
      await service.createIdempotencyKey(key, 'claim', 'https://example.com', {});
      const result = await service.markAsFailed(key, 'Network error');
      expect(result).toBe(true);
    });
  });

  describe('cleanupExpiredKeys', () => {
    it('should delete expired keys', async () => {
      const key1 = 'valid-key-cleanup';
      const key2 = 'expired-key-cleanup';
      await service.createIdempotencyKey(key1, 'claim', 'https://example.com', {});
      await service.createIdempotencyKey(key2, 'claim', 'https://example.com', {}, -1);
      const deletedCount = await service.cleanupExpiredKeys();
      expect(deletedCount).toBe(1);
    });
  });

  describe('getStatistics', () => {
    it('should return accurate statistics', async () => {
      await service.createIdempotencyKey('key1', 'claim', 'https://example.com', {});
      await service.createIdempotencyKey('key2', 'claim', 'https://example.com', {});
      await service.createIdempotencyKey('key3', 'claim', 'https://example.com', {}, -1);
      await service.markAsCompleted('key1');
      await service.markAsFailed('key2', 'Test error');
      const stats = await service.getStatistics();
      expect(stats.total).toBe(3);
      expect(stats.expired).toBe(1);
      expect(stats.byStatus.completed).toBe(1);
      expect(stats.byStatus.failed).toBe(1);
    });
  });

  describe('executeWithIdempotency', () => {
    it('should execute operation and cache result for first time', async () => {
      const mockOperation = jest.fn().mockResolvedValue({
        success: true,
        responseStatus: 200,
        responseBody: 'Operation successful',
      });
      const result = await service.executeWithIdempotency('claim', 'https://example.com/webhook', { event: 'test' }, mockOperation);
      expect(result.success).toBe(true);
      expect(result.fromCache).toBe(false);
      expect(mockOperation).toHaveBeenCalledTimes(1);
    });

    it.skip('should return cached result for subsequent calls', async () => {
      const mockOperation = jest.fn().mockResolvedValue({
        success: true,
        responseStatus: 200,
        responseBody: 'Operation successful',
      });
      await service.executeWithIdempotency('claim', 'https://example.com/webhook', { event: 'test' }, mockOperation);
      const result = await service.executeWithIdempotency('claim', 'https://example.com/webhook', { event: 'test' }, mockOperation);
      expect(result.fromCache).toBe(true);
      expect(mockOperation).toHaveBeenCalledTimes(1);
    });

    it('should handle operation failure and mark as failed', async () => {
      const mockOperation = jest.fn().mockRejectedValue(new Error('Operation failed'));
      await expect(
        service.executeWithIdempotency('claim', 'https://example.com', { event: 'test' }, mockOperation)
      ).rejects.toThrow('Operation failed');
    });

    it.skip('should return cached failure for subsequent calls after failure', async () => {
      const mockOperation = jest.fn().mockRejectedValue(new Error('Operation failed'));
      try { await service.executeWithIdempotency('claim', 'https://example.com', { event: 'test' }, mockOperation); } catch (e) {}
      const result = await service.executeWithIdempotency('claim', 'https://example.com', { event: 'test' }, mockOperation);
      expect(result.success).toBe(false);
      expect(result.fromCache).toBe(true);
      expect(mockOperation).toHaveBeenCalledTimes(1);
    });
  });
});
