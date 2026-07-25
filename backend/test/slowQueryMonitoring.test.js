/**
 * Tests for Issue #49: PostgreSQL Query Performance Monitoring and Slow Query Alerting
 *
 * Tests cover:
 *   - QueryClassifier: normalization, classification, persistence
 *   - SlowQueryAlertEngine: severity determination, alert evaluation, PagerDuty
 *   - Slow Query Routes: dashboard, plan viewer, alert endpoints
 */

const QueryClassifier = require('../src/services/queryClassifier');
const SlowQueryAlertEngine = require('../src/services/slowQueryAlertEngine');
const SlowQueryCollector = require('../src/services/slowQueryCollector');
const { SlowQuery, SlowQueryAlert } = require('../src/models');
const { sequelize } = require('../src/database/connection');

// Mock axios for PagerDuty calls
jest.mock('axios', () => ({
  post: jest.fn().mockResolvedValue({ data: { dedup_key: 'pd-incident-123' } }),
}));

// Mock criticalAlertService (no longer used directly, but module may still be required)
jest.mock('../src/services/criticalAlertService', () => ({
  sendVaultBalanceDiscrepancyAlert: jest.fn().mockResolvedValue({ sent: true, channels: ['slack'] }),
}));

describe('QueryClassifier', () => {
  let classifier;

  beforeEach(() => {
    classifier = new QueryClassifier();
  });

  describe('normalizeQuery', () => {
    test('replaces string literals with placeholder', () => {
      const result = classifier.normalizeQuery("SELECT * FROM users WHERE email = 'test@example.com'");
      expect(result).not.toContain('test@example.com');
      expect(result).toContain("'?'");
    });

    test('replaces numeric literals with placeholder', () => {
      const result = classifier.normalizeQuery('SELECT * FROM vaults WHERE total_amount > 1000000');
      expect(result).not.toContain('1000000');
      expect(result).toContain('?');
      expect(result).toMatch(/WHERE total_amount > \?/);
    });

    test('collapses multiple whitespace', () => {
      const result = classifier.normalizeQuery('SELECT   *    FROM    users');
      expect(result).toBe('SELECT * FROM users');
    });

    test('handles empty or null input', () => {
      expect(classifier.normalizeQuery('')).toBe('');
      expect(classifier.normalizeQuery(null)).toBe('');
    });
  });

  describe('extractQueryType', () => {
    test('identifies SELECT queries', () => {
      expect(classifier.extractQueryType('SELECT * FROM vaults')).toBe('SELECT');
    });

    test('identifies INSERT queries', () => {
      expect(classifier.extractQueryType('INSERT INTO vaults (id, name) VALUES (?, ?)')).toBe('INSERT');
    });

    test('identifies UPDATE queries', () => {
      expect(classifier.extractQueryType('UPDATE vaults SET name = ? WHERE id = ?')).toBe('UPDATE');
    });

    test('identifies DELETE queries', () => {
      expect(classifier.extractQueryType('DELETE FROM notifications WHERE created_at < ?')).toBe('DELETE');
    });

    test('returns EXPLAIN for EXPLAIN queries', () => {
      expect(classifier.extractQueryType('EXPLAIN ANALYZE SELECT * FROM vaults')).toBe('EXPLAIN');
    });

    test('handles null input', () => {
      expect(classifier.extractQueryType(null)).toBe('OTHER');
    });
  });

  describe('extractTableName', () => {
    test('extracts table from FROM clause', () => {
      expect(classifier.extractTableName('SELECT * FROM vaults')).toBe('vaults');
    });

    test('extracts table from INSERT INTO', () => {
      expect(classifier.extractTableName('INSERT INTO beneficiaries (id) VALUES (?)')).toBe('beneficiaries');
    });

    test('extracts table from UPDATE', () => {
      expect(classifier.extractTableName('UPDATE claims_history SET amount = ?')).toBe('claims_history');
    });

    test('extracts table from JOIN', () => {
      expect(classifier.extractTableName('SELECT * FROM vaults JOIN organizations ON vaults.org_id = organizations.id')).toBe('vaults');
    });

    test('returns null when no table found', () => {
      expect(classifier.extractTableName('SELECT 1')).toBeNull();
    });
  });

  describe('extractApplicationName', () => {
    test('extracts app name from comment hint', () => {
      const result = classifier.extractApplicationName('/* app:myapp */ SELECT * FROM vaults');
      expect(result).toBe('myapp');
    });

    test('returns null when no hint present', () => {
      expect(classifier.extractApplicationName('SELECT * FROM vaults')).toBeNull();
    });
  });

  describe('classify', () => {
    test('returns classified object with all fields', () => {
      const rawQuery = "SELECT * FROM vaults WHERE total_amount > 1000";
      const result = classifier.classify({
        rawQuery,
        queryId: 12345,
        calls: 100,
        meanTimeMs: 350.5,
        totalTimeMs: 35050,
        stddevTimeMs: 50.2,
        minTimeMs: 200,
        maxTimeMs: 500,
      });

      expect(result).toMatchObject({
        normalizedQuery: expect.any(String),
        rawQuery: rawQuery,
        queryType: 'SELECT',
        tableName: 'vaults',
        queryId: 12345,
        calls: 100,
        meanTimeMs: 350.5,
        totalTimeMs: 35050,
        stddevTimeMs: 50.2,
        minTimeMs: 200,
        maxTimeMs: 500,
      });
    });
  });
});

describe('SlowQueryAlertEngine', () => {
  let alertEngine;

  beforeAll(async () => {
    await sequelize.sync({ force: true });
  });

  beforeEach(() => {
    alertEngine = new SlowQueryAlertEngine({ pagerDutyRoutingKey: 'test-routing-key' });
  });

  describe('determineSeverity', () => {
    test('returns warning for mean time >= 200ms and < 1000ms', () => {
      expect(alertEngine.determineSeverity(200)).toBe('warning');
      expect(alertEngine.determineSeverity(500)).toBe('warning');
      expect(alertEngine.determineSeverity(999)).toBe('warning');
    });

    test('returns critical for mean time >= 1000ms and < 5000ms', () => {
      expect(alertEngine.determineSeverity(1000)).toBe('critical');
      expect(alertEngine.determineSeverity(2500)).toBe('critical');
      expect(alertEngine.determineSeverity(4999)).toBe('critical');
    });

    test('returns emergency for mean time >= 5000ms', () => {
      expect(alertEngine.determineSeverity(5000)).toBe('emergency');
      expect(alertEngine.determineSeverity(10000)).toBe('emergency');
    });

    test('returns null for mean time < 200ms', () => {
      expect(alertEngine.determineSeverity(0)).toBeNull();
      expect(alertEngine.determineSeverity(100)).toBeNull();
      expect(alertEngine.determineSeverity(199)).toBeNull();
    });

    test('handles non-numeric input', () => {
      expect(alertEngine.determineSeverity(null)).toBeNull();
      expect(alertEngine.determineSeverity(undefined)).toBeNull();
      expect(alertEngine.determineSeverity('abc')).toBeNull();
    });
  });

  describe('getAlertStats', () => {
    test('returns stats with correct structure', async () => {
      const stats = await alertEngine.getAlertStats();

      expect(stats).toMatchObject({
        totalAlerts: expect.any(Number),
        recentAlerts: expect.any(Number),
        unacknowledged: expect.any(Number),
        windowMs: 300000,
        thresholds: {
          warning: 200,
          critical: 1000,
          emergency: 5000,
        },
      });
    });
  });

  describe('acknowledgeAlert', () => {
    test('throws when alert not found', async () => {
      await expect(
        alertEngine.acknowledgeAlert('00000000-0000-0000-0000-000000000000', 'admin')
      ).rejects.toThrow('Alert not found');
    });
  });
});

describe('Thresholds Configuration', () => {
  test('thresholds match specification: warning=200ms, critical=1000ms, emergency=5000ms', () => {
    const engine = new SlowQueryAlertEngine();

    expect(engine.determineSeverity(200)).toBe('warning');
    expect(engine.determineSeverity(199)).toBeNull();

    expect(engine.determineSeverity(1000)).toBe('critical');
    expect(engine.determineSeverity(999)).toBe('warning');

    expect(engine.determineSeverity(5000)).toBe('emergency');
    expect(engine.determineSeverity(4999)).toBe('critical');
  });
});

describe('QueryClassifier persistClassified', () => {
  beforeAll(async () => {
    await sequelize.sync({ force: true });
  });

  beforeEach(async () => {
    await SlowQuery.destroy({ truncate: true, cascade: true, force: true });
  });

  test('creates new SlowQuery records', async () => {
    const classifier = new QueryClassifier();

    const entries = [{
      normalizedQuery: 'SELECT * FROM ? WHERE ? > ?',
      rawQuery: 'SELECT * FROM vaults WHERE total_amount > 1000',
      queryType: 'SELECT',
      tableName: 'vaults',
      applicationName: null,
      calls: 50,
      meanTimeMs: 300,
      totalTimeMs: 15000,
      stddevTimeMs: 25,
      minTimeMs: 200,
      maxTimeMs: 400,
    }];

    const results = await classifier.persistClassified(entries);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: expect.any(String),
      created: true,
    });

    const saved = await SlowQuery.findByPk(results[0].id);
    expect(saved).toBeTruthy();
    expect(saved.query_type).toBe('SELECT');
    expect(saved.call_count).toBe(50);
  });

  test('updates running statistics for existing queries', async () => {
    const classifier = new QueryClassifier();

    await classifier.persistClassified([{
      normalizedQuery: 'UPDATE ? SET ? = ?',
      rawQuery: 'UPDATE organizations SET name = ?',
      queryType: 'UPDATE',
      tableName: 'organizations',
      applicationName: null,
      calls: 10,
      meanTimeMs: 400,
      totalTimeMs: 4000,
      stddevTimeMs: 30,
      minTimeMs: 350,
      maxTimeMs: 450,
    }]);

    const results = await classifier.persistClassified([{
      normalizedQuery: 'UPDATE ? SET ? = ?',
      rawQuery: 'UPDATE organizations SET name = ?',
      queryType: 'UPDATE',
      tableName: 'organizations',
      applicationName: null,
      calls: 20,
      meanTimeMs: 500,
      totalTimeMs: 10000,
      stddevTimeMs: 40,
      minTimeMs: 400,
      maxTimeMs: 600,
    }]);

    expect(results[0].created).toBe(false);

    const saved = await SlowQuery.findByPk(results[0].id);
    expect(saved.call_count).toBe(30);
    expect(saved.max_time_ms).toBe(600);
    expect(saved.min_time_ms).toBe(350);
  });
});

describe('Slow Query Routes', () => {
  let app;
  const request = require('supertest');

  beforeAll(async () => {
    await sequelize.sync({ force: true });
  });

  beforeEach(async () => {
    await SlowQueryAlert.destroy({ truncate: true, cascade: true, force: true });
    await SlowQuery.destroy({ truncate: true, cascade: true, force: true });

    const express = require('express');
    app = express();
    app.use(express.json());
    const slowQueryRoutes = require('../src/routes/slowQueryRoutes');
    app.use('/api/slow-queries', slowQueryRoutes);
  });

  describe('GET /api/slow-queries/stats', () => {
    test('returns stats with correct structure', async () => {
      const res = await request(app).get('/api/slow-queries/stats');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        totalAlerts: expect.any(Number),
        recentAlerts: expect.any(Number),
        unacknowledged: expect.any(Number),
        totalTrackedQueries: expect.any(Number),
        thresholds: {
          warning: 200,
          critical: 1000,
          emergency: 5000,
        },
      });
    });
  });

  describe('GET /api/slow-queries', () => {
    test('returns empty list when no queries tracked', async () => {
      const res = await request(app).get('/api/slow-queries');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.queries).toEqual([]);
      expect(res.body.data.total).toBe(0);
    });

    test('returns queries with correct structure', async () => {
      await SlowQuery.create({
        normalized_query: 'SELECT * FROM ? WHERE ? > ?',
        query_type: 'SELECT',
        table_name: 'vaults',
        call_count: 100,
        mean_time_ms: 350.5,
        total_time_ms: 35050,
        stddev_time_ms: 50.2,
        min_time_ms: 200,
        max_time_ms: 500,
        last_seen: new Date(),
      });

      const res = await request(app).get('/api/slow-queries');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.queries).toHaveLength(1);
      expect(res.body.data.queries[0]).toMatchObject({
        query_type: 'SELECT',
        table_name: 'vaults',
        call_count: 100,
        mean_time_ms: 350.5,
      });
    });

    test('supports filtering by query_type', async () => {
      await SlowQuery.create({
        normalized_query: 'SELECT * FROM ?',
        query_type: 'SELECT',
        table_name: 'vaults',
        call_count: 50,
        mean_time_ms: 300,
        total_time_ms: 15000,
        stddev_time_ms: 20,
        min_time_ms: 200,
        max_time_ms: 400,
      });

      await SlowQuery.create({
        normalized_query: 'INSERT INTO ?',
        query_type: 'INSERT',
        table_name: 'beneficiaries',
        call_count: 20,
        mean_time_ms: 250,
        total_time_ms: 5000,
        stddev_time_ms: 10,
        min_time_ms: 200,
        max_time_ms: 300,
      });

      const res = await request(app).get('/api/slow-queries?query_type=INSERT');
      expect(res.status).toBe(200);
      expect(res.body.data.queries).toHaveLength(1);
      expect(res.body.data.queries[0].query_type).toBe('INSERT');
    });

    test('supports sorting by call_count ascending', async () => {
      await SlowQuery.create({
        normalized_query: 'SELECT a FROM ?',
        query_type: 'SELECT',
        table_name: 'a',
        call_count: 10,
        mean_time_ms: 300,
        total_time_ms: 3000,
        stddev_time_ms: 20,
        min_time_ms: 200,
        max_time_ms: 400,
      });

      await SlowQuery.create({
        normalized_query: 'SELECT b FROM ?',
        query_type: 'SELECT',
        table_name: 'b',
        call_count: 100,
        mean_time_ms: 350,
        total_time_ms: 35000,
        stddev_time_ms: 25,
        min_time_ms: 200,
        max_time_ms: 500,
      });

      const res = await request(app).get('/api/slow-queries?sort_by=call_count&sort_dir=asc');
      expect(res.status).toBe(200);
      expect(res.body.data.queries[0].call_count).toBeLessThanOrEqual(
        res.body.data.queries[1].call_count
      );
    });
  });

  describe('GET /api/slow-queries/top', () => {
    test('returns top 5 queries sorted by mean_time_ms', async () => {
      for (let i = 0; i < 7; i++) {
        await SlowQuery.create({
          normalized_query: `SELECT ${i} FROM ?`,
          query_type: 'SELECT',
          table_name: `table_${i}`,
          call_count: 10,
          mean_time_ms: 200 + i * 100,
          total_time_ms: (200 + i * 100) * 10,
          stddev_time_ms: 20,
          min_time_ms: 100,
          max_time_ms: 300,
        });
      }

      const res = await request(app).get('/api/slow-queries/top');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(5);
      expect(res.body.data[0].mean_time_ms).toBeGreaterThanOrEqual(
        res.body.data[4].mean_time_ms
      );
    });
  });

  describe('GET /api/slow-queries/:id/plan', () => {
    test('returns 404 for non-existent query', async () => {
      const res = await request(app).get(
        '/api/slow-queries/00000000-0000-0000-0000-000000000000/plan'
      );
      expect(res.status).toBe(404);
    });

    test('returns plan data for cached plan', async () => {
      const query = await SlowQuery.create({
        normalized_query: 'SELECT * FROM ?',
        query_type: 'SELECT',
        table_name: 'vaults',
        call_count: 10,
        mean_time_ms: 500,
        total_time_ms: 5000,
        stddev_time_ms: 50,
        min_time_ms: 400,
        max_time_ms: 600,
        plan_data: [{ Plan: { 'Node Type': 'Seq Scan' } }],
      });

      const res = await request(app).get(`/api/slow-queries/${query.id}/plan`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.plan).toEqual([{ Plan: { 'Node Type': 'Seq Scan' } }]);
    });
  });

  describe('POST /api/slow-queries/alerts/:id/acknowledge', () => {
    test('returns 400 when acknowledged_by is missing', async () => {
      const res = await request(app)
        .post('/api/slow-queries/alerts/some-id/acknowledge')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('acknowledged_by');
    });
  });
});
