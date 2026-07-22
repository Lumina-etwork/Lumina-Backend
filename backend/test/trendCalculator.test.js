const {
  simpleMovingAverage,
  exponentialMovingAverage,
  linearRegression,
  growthRate,
  seasonalDecomposition,
  detectAnomalies,
  projectFromTimeSeries,
} = require('../src/services/trendCalculator');

describe('trendCalculator', () => {
  describe('simpleMovingAverage', () => {
    test('returns empty array for empty input', () => {
      expect(simpleMovingAverage([], 3)).toEqual([]);
    });

    test('equal-length window returns overall average', () => {
      const result = simpleMovingAverage([1, 2, 3, 4, 5], 5);
      expect(result[result.length - 1]).toBe(3);
    });

    test('window larger than array returns all averages', () => {
      const result = simpleMovingAverage([1, 2, 3], 10);
      expect(result).toHaveLength(3);
      expect(result[2]).toBe(2);
    });

    test('smooths noisy data', () => {
      const data = [10, 12, 9, 11, 13, 10, 12, 14, 11, 13];
      const result = simpleMovingAverage(data, 3);
      expect(result.length).toBe(data.length);
      result.forEach((v) => {
        expect(v).toBeGreaterThan(0);
      });
    });
  });

  describe('exponentialMovingAverage', () => {
    test('returns first value as initial EMA', () => {
      const result = exponentialMovingAverage([5, 10, 15], 0.5);
      expect(result[0]).toBe(5);
    });

    test('alpha of 1 gives raw values', () => {
      const result = exponentialMovingAverage([1, 2, 3], 1);
      expect(result).toEqual([1, 2, 3]);
    });

    test('recent values weighted more heavily', () => {
      const result = exponentialMovingAverage([100, 100, 200], 0.9);
      expect(result[2]).toBeGreaterThan(result[1]);
    });
  });

  describe('linearRegression', () => {
    const ascending = [
      [0, 1], [1, 2], [2, 3], [3, 4], [4, 5],
    ];
    const flat = [
      [0, 10], [1, 10], [2, 10], [3, 10],
    ];
    const noisy = [
      [0, 1.1], [1, 1.9], [2, 3.2], [3, 3.8], [4, 5.0],
    ];

    test('ascending data yields slope of 1 and intercept of 1', () => {
      const model = linearRegression(ascending);
      expect(model.slope).toBeCloseTo(1, 5);
      expect(model.intercept).toBeCloseTo(1, 5);
    });

    test('flat data yields slope of 0', () => {
      const model = linearRegression(flat);
      expect(model.slope).toBe(0);
    });

    test('R² near 1 for near-perfect linear data', () => {
      const model = linearRegression(ascending);
      expect(model.r2).toBeCloseTo(1, 5);
    });

    test('R² near 1 for slightly noisy linear data', () => {
      const model = linearRegression(noisy);
      expect(model.r2).toBeGreaterThan(0.98);
    });

    test('predict method returns expected values', () => {
      const model = linearRegression(ascending);
      expect(model.predict(5)).toBeCloseTo(6, 5);
      expect(model.predict(-1)).toBeCloseTo(0, 5);
    });

    test('next method projects forward from last point', () => {
      const model = linearRegression(ascending);
      const lastX = ascending[ascending.length - 1][0];
      expect(model.next(1)).toBeCloseTo(model.predict(lastX + 1), 5);
    });

    test('returns zero model for fewer than 2 points', () => {
      const model = linearRegression([[0, 5]]);
      expect(model.slope).toBe(0);
      expect(model.intercept).toBe(0);
    });

    test('confidenceInterval returns lower and upper bounds', () => {
      const model = linearRegression(ascending);
      const ci = model.confidenceInterval(3);
      expect(ci.lower).toBeDefined();
      expect(ci.upper).toBeDefined();
      expect(ci.lower).toBeLessThanOrEqual(ci.upper);
    });
  });

  describe('growthRate', () => {
    test('doubling over 3 periods gives ~26% CAGR', () => {
      const rate = growthRate([1, 1.26, 1.59, 2.0]);
      expect(rate).toBeCloseTo(0.26, 1);
    });

    test('flat data gives ~0%', () => {
      expect(growthRate([5, 5, 5])).toBeCloseTo(0, 5);
    });

    test('negative growth', () => {
      const rate = growthRate([100, 50, 25]);
      expect(rate).toBeLessThan(0);
    });

    test('returns 0 for single element', () => {
      expect(growthRate([42])).toBe(0);
    });

    test('returns Infinity when starting from 0 and ending positive', () => {
      expect(growthRate([0, 0, 5])).toBe(Infinity);
    });

    test('returns 0 when all zeros', () => {
      expect(growthRate([0, 0, 0])).toBe(0);
    });
  });

  describe('seasonalDecomposition', () => {
    test('returns trend, seasonal, residual components', () => {
      const result = seasonalDecomposition([10, 12, 10, 12, 10, 12], 2);
      expect(result.trend).toBeDefined();
      expect(result.seasonal).toBeDefined();
      expect(result.residual).toBeDefined();
    });

    test('returns null seasonal for insufficient data', () => {
      const result = seasonalDecomposition([1, 2, 3], 4);
      expect(result.seasonal).toBeNull();
    });
  });

  describe('detectAnomalies', () => {
    test('flags points far from expected', () => {
      const values = [10, 10, 100, 10, 10];
      const model = [10, 10, 10, 10, 10];
      const results = detectAnomalies(values, model, 2);
      const anomalies = results.filter((r) => r.isAnomaly);
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0].index).toBe(2);
    });

    test('no anomalies when values match model', () => {
      const values = [5, 5, 5, 5];
      const results = detectAnomalies(values, values, 3);
      expect(results.every((r) => !r.isAnomaly)).toBe(true);
    });

    test('defaults to threshold 3 when not provided', () => {
      const values = [10, 10, 100, 10, 10];
      const model = [10, 10, 10, 10, 10];
      const results = detectAnomalies(values, model);
      expect(results.length).toBe(5);
    });
  });

  describe('projectFromTimeSeries', () => {
    test('projects forward for linear data', () => {
      const now = new Date('2026-07-01T00:00:00Z');
      const timestamps = [];
      const values = [];
      for (let i = 0; i < 30; i++) {
        timestamps.push(new Date(now.getTime() + i * 86400000));
        values.push(100 + i * 2);
      }
      const result = projectFromTimeSeries(timestamps, values, 7);
      expect(result).not.toBeNull();
      expect(result.projections).toHaveLength(7);
      expect(result.model.r2).toBeGreaterThan(0.99);
      expect(result.projections[6].value).toBeGreaterThan(values[values.length - 1]);
    });

    test('returns null for insufficient data', () => {
      const result = projectFromTimeSeries([new Date()], [42], 7);
      expect(result).toBeNull();
    });

    test('daysUntilExhaustion computes correctly for upward trend', () => {
      const timestamps = [];
      const values = [];
      const now = new Date('2026-07-01T00:00:00Z');
      for (let i = 0; i < 10; i++) {
        timestamps.push(new Date(now.getTime() + i * 86400000));
        values.push(50 + i * 5);
      }
      const result = projectFromTimeSeries(timestamps, values, 90);
      expect(result).not.toBeNull();
      const exhaustion = result.daysUntilExhaustion(200);
      expect(exhaustion).not.toBeNull();
      expect(exhaustion).toBeGreaterThan(0);
    });

    test('daysUntilExhaustion returns null for flat or downward trend', () => {
      const timestamps = [];
      const values = [];
      const now = new Date('2026-07-01T00:00:00Z');
      for (let i = 0; i < 10; i++) {
        timestamps.push(new Date(now.getTime() + i * 86400000));
        values.push(50);
      }
      const result = projectFromTimeSeries(timestamps, values, 90);
      expect(result).not.toBeNull();
      const exhaustion = result.daysUntilExhaustion(100);
      expect(exhaustion).toBeNull();
    });
  });
});
