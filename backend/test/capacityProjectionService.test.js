const CapacityProjectionService = require('../src/services/capacityProjectionService');

describe('CapacityProjectionService', () => {
  let mockStore;
  let service;

  beforeEach(() => {
    mockStore = {
      getTimeSeries: jest.fn(),
      getLatestValue: jest.fn(),
    };
    service = new CapacityProjectionService({ store: mockStore });
  });

  describe('getTrendSummary', () => {
    test('returns three windows with trend data', async () => {
      const now = Date.now();
      const dataPoints = [];
      for (let i = 30; i >= 0; i--) {
        dataPoints.push({
          snapshot_time: new Date(now - i * 86400000),
          metric_value: 50 + i * 0.5,
        });
      }
      mockStore.getTimeSeries.mockResolvedValue(dataPoints);

      const summaries = await service.getTrendSummary('test_metric');
      expect(summaries).toHaveLength(3);
      expect(summaries[0].window).toBe('7d');
      expect(summaries[1].window).toBe('30d');
      expect(summaries[2].window).toBe('90d');
      summaries.forEach((s) => {
        expect(s.data_points).toBeGreaterThan(0);
        expect(s.current_value).toBeDefined();
      });
    });

    test('handles insufficient data gracefully', async () => {
      mockStore.getTimeSeries.mockResolvedValue([{ snapshot_time: new Date(), metric_value: 42 }]);

      const summaries = await service.getTrendSummary('test_metric');
      expect(summaries).toHaveLength(3);
      expect(summaries[0].growth_rate).toBeNull();
    });

    test('passes labels and source to store', async () => {
      mockStore.getTimeSeries.mockResolvedValue([]);

      await service.getTrendSummary('test_metric', { labels: { route: '/api/test' }, source: 'prometheus' });
      expect(mockStore.getTimeSeries).toHaveBeenCalledWith('test_metric', expect.objectContaining({
        labels: { route: '/api/test' },
        source: 'prometheus',
      }));
    });
  });

  describe('project', () => {
    test('returns projection for data with sufficient points', async () => {
      const now = Date.now();
      const dataPoints = [];
      for (let i = 60; i >= 0; i--) {
        dataPoints.push({
          snapshot_time: new Date(now - i * 86400000),
          metric_value: 100 + i * 0.3,
        });
      }
      mockStore.getTimeSeries.mockResolvedValue(dataPoints);

      const result = await service.project('test_metric', { daysAhead: 14 });
      expect(result).not.toBeNull();
      expect(result.metric_name).toBe('test_metric');
      expect(result.projections).toHaveLength(14);
      expect(result.data_points).toBeGreaterThan(0);
      expect(result.confidence).toMatch(/^(high|medium|low)$/);
    });

    test('returns null for insufficient data', async () => {
      mockStore.getTimeSeries.mockResolvedValue([{ snapshot_time: new Date(), metric_value: 42 }]);

      const result = await service.project('test_metric', { daysAhead: 7 });
      expect(result).toBeNull();
    });

    test('returns null for empty data', async () => {
      mockStore.getTimeSeries.mockResolvedValue([]);
      const result = await service.project('test_metric', { daysAhead: 7 });
      expect(result).toBeNull();
    });
  });

  describe('daysUntilExhaustion', () => {
    test('returns days for upward trend', async () => {
      const now = Date.now();
      const dataPoints = [];
      for (let i = 0; i <= 20; i++) {
        dataPoints.push({
          snapshot_time: new Date(now - (20 - i) * 86400000),
          metric_value: 30 + i,
        });
      }
      mockStore.getTimeSeries.mockResolvedValue(dataPoints);

      const result = await service.daysUntilExhaustion('test_metric', 100);
      expect(result).not.toBeNull();
      expect(result.days).toBeGreaterThan(0);
      expect(result.exhausted).toBe(false);
      expect(result.capacity_limit).toBe(100);
    });

    test('returns exhausted true when already above limit', async () => {
      const now = Date.now();
      mockStore.getTimeSeries.mockResolvedValue([
        { snapshot_time: new Date(now - 86400000), metric_value: 50 },
        { snapshot_time: new Date(now), metric_value: 120 },
      ]);

      const result = await service.daysUntilExhaustion('test_metric', 100);
      expect(result).not.toBeNull();
      expect(result.exhausted).toBe(true);
      expect(result.days).toBe(0);
    });

    test('returns null days for flat trend', async () => {
      const now = Date.now();
      const dataPoints = [];
      for (let i = 10; i >= 0; i--) {
        dataPoints.push({
          snapshot_time: new Date(now - i * 86400000),
          metric_value: 50,
        });
      }
      mockStore.getTimeSeries.mockResolvedValue(dataPoints);

      const result = await service.daysUntilExhaustion('test_metric', 100);
      expect(result.days).toBeNull();
      expect(result.exhausted).toBe(false);
    });
  });

  describe('getAlertState', () => {
    test('returns ok when no thresholds exceeded', async () => {
      mockStore.getLatestValue.mockResolvedValue(30);

      const state = await service.getAlertState('test_metric', { warningThreshold: 80, criticalThreshold: 90 });
      expect(state.level).toBe('ok');
      expect(state.current_value).toBe(30);
    });

    test('returns warning when warning threshold exceeded', async () => {
      mockStore.getLatestValue.mockResolvedValue(85);

      const state = await service.getAlertState('test_metric', { warningThreshold: 80, criticalThreshold: 90 });
      expect(state.level).toBe('warning');
    });

    test('returns critical when critical threshold exceeded', async () => {
      mockStore.getLatestValue.mockResolvedValue(95);

      const state = await service.getAlertState('test_metric', { warningThreshold: 80, criticalThreshold: 90 });
      expect(state.level).toBe('critical');
    });

    test('returns unknown when no data', async () => {
      mockStore.getLatestValue.mockResolvedValue(null);

      const state = await service.getAlertState('test_metric');
      expect(state.level).toBe('unknown');
    });
  });
});
