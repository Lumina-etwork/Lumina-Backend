const HistoricalUsageStore = require('../src/services/historicalUsageStore');
const { sequelize } = require('../src/database/connection');

describe('HistoricalUsageStore', () => {
  let store;

  beforeAll(async () => {
    await sequelize.sync({ force: true });
  });

  beforeEach(async () => {
    store = new HistoricalUsageStore();
    await sequelize.sync({ force: true });
  });

  describe('record', () => {
    test('records a single entry', async () => {
      const count = await store.record({
        metric_name: 'test_metric',
        metric_value: 42.5,
        snapshot_time: new Date(),
        source: 'test',
      });
      expect(count).toBe(1);
    });

    test('records multiple entries in batch', async () => {
      const entries = [
        { metric_name: 'cpu_usage', metric_value: 0.5, snapshot_time: new Date(), source: 'test' },
        { metric_name: 'memory_usage', metric_value: 1024, snapshot_time: new Date(), source: 'test' },
      ];
      const count = await store.record(entries);
      expect(count).toBe(2);
    });

    test('returns 0 for empty array', async () => {
      const count = await store.record([]);
      expect(count).toBe(0);
    });

    test('includes labels when provided', async () => {
      const count = await store.record({
        metric_name: 'api_latency',
        metric_value: 150,
        labels: { route: '/api/vaults', method: 'GET' },
        snapshot_time: new Date(),
        source: 'middleware',
      });
      expect(count).toBe(1);
    });
  });

  describe('query', () => {
    test('returns all records', async () => {
      await store.record({ metric_name: 'a', metric_value: 1, snapshot_time: new Date(), source: 'test' });
      await store.record({ metric_name: 'b', metric_value: 2, snapshot_time: new Date(), source: 'test' });

      const results = await store.query({});
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    test('filters by metric_name', async () => {
      await store.record({ metric_name: 'target', metric_value: 1, snapshot_time: new Date(), source: 'test' });
      await store.record({ metric_name: 'other', metric_value: 2, snapshot_time: new Date(), source: 'test' });

      const results = await store.query({ metric_name: 'target' });
      expect(results.every((r) => r.metric_name === 'target')).toBe(true);
    });
  });

  describe('listMetrics', () => {
    test('returns metric names with stats', async () => {
      await store.record({ metric_name: 'alpha', metric_value: 10, snapshot_time: new Date(), source: 'test' });
      await store.record({ metric_name: 'alpha', metric_value: 20, snapshot_time: new Date(), source: 'test' });
      await store.record({ metric_name: 'beta', metric_value: 30, snapshot_time: new Date(), source: 'test' });

      const metrics = await store.listMetrics();
      const alpha = metrics.find((m) => m.metric_name === 'alpha');
      expect(alpha).toBeDefined();
      expect(alpha.sample_count).toBe(2);
    });
  });

  describe('getLatestValue', () => {
    test('returns most recent value for metric', async () => {
      const early = new Date('2026-01-01');
      const late = new Date('2026-07-01');
      await store.record({ metric_name: 'voltage', metric_value: 5, snapshot_time: early, source: 'test' });
      await store.record({ metric_name: 'voltage', metric_value: 12, snapshot_time: late, source: 'test' });

      const value = await store.getLatestValue('voltage');
      expect(value).toBe(12);
    });

    test('returns null for unknown metric', async () => {
      const value = await store.getLatestValue('nonexistent');
      expect(value).toBeNull();
    });
  });

  describe('getTimeSeries', () => {
    test('returns raw data ordered by time', async () => {
      const t1 = new Date('2026-01-01');
      const t2 = new Date('2026-01-02');
      await store.record({ metric_name: 'm1', metric_value: 1, snapshot_time: t2, source: 'test' });
      await store.record({ metric_name: 'm1', metric_value: 2, snapshot_time: t1, source: 'test' });

      const data = await store.getTimeSeries('m1');
      expect(data).toHaveLength(2);
      expect(new Date(data[0].snapshot_time).getTime()).toBeLessThan(new Date(data[1].snapshot_time).getTime());
    });

    test('applies time window filtering', async () => {
      const inside = new Date('2026-06-15');
      const outside = new Date('2026-01-01');
      await store.record({ metric_name: 'm1', metric_value: 1, snapshot_time: inside, source: 'test' });
      await store.record({ metric_name: 'm1', metric_value: 2, snapshot_time: outside, source: 'test' });

      const data = await store.getTimeSeries('m1', {
        from: new Date('2026-06-01'),
        to: new Date('2026-07-01'),
      });
      expect(data).toHaveLength(1);
    });
  });

  describe('prune', () => {
    test('removes records before given date', async () => {
      const old = new Date('2025-01-01');
      const recent = new Date('2026-07-01');
      await store.record({ metric_name: 'm1', metric_value: 1, snapshot_time: old, source: 'test' });
      await store.record({ metric_name: 'm1', metric_value: 2, snapshot_time: recent, source: 'test' });

      const deleted = await store.prune({ before: new Date('2026-06-01') });
      expect(deleted).toBe(1);
      const remaining = await store.query({ metric_name: 'm1' });
      expect(remaining).toHaveLength(1);
    });
  });

  describe('getRetentionStats', () => {
    test('returns oldest, newest, and count', async () => {
      const t1 = new Date('2026-01-01');
      const t2 = new Date('2026-07-01');
      await store.record({ metric_name: 'm1', metric_value: 1, snapshot_time: t1, source: 'test' });
      await store.record({ metric_name: 'm1', metric_value: 2, snapshot_time: t2, source: 'test' });

      const stats = await store.getRetentionStats();
      expect(stats.count).toBeGreaterThanOrEqual(2);
      expect(stats.oldest).toBeDefined();
      expect(stats.newest).toBeDefined();
    });
  });
});
