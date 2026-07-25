/**
 * Slow Query Monitoring Routes
 *
 * Issue #49: PostgreSQL Query Performance Monitoring and Slow Query Alerting
 *
 * Endpoints:
 *   GET  /api/slow-queries          - Dashboard: table of slow queries with sorting
 *   GET  /api/slow-queries/:id/plan - EXPLAIN ANALYZE plan viewer for a query
 *   GET  /api/slow-queries/top      - Top 5 slow queries with EXPLAIN plans
 *   GET  /api/slow-queries/alerts   - Alert history
 *   POST /api/slow-queries/alerts/:id/acknowledge - Acknowledge an alert
 *   POST /api/slow-queries/collect  - Trigger manual collection
 *   GET  /api/slow-queries/stats    - Alert statistics
 */

const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const { sequelize } = require('../database/connection');
const { SlowQuery, SlowQueryAlert } = require('../models');
const SlowQueryCollector = require('../services/slowQueryCollector');
const QueryClassifier = require('../services/queryClassifier');
const SlowQueryAlertEngine = require('../services/slowQueryAlertEngine');

const classifier = new QueryClassifier();
const collector = new SlowQueryCollector({ classifier });
const alertEngine = new SlowQueryAlertEngine();

/**
 * GET /api/slow-queries
 * Dashboard table of slow queries with sortable columns.
 * Supports: sort_by, sort_dir, limit, offset, query_type, severity filters.
 */
router.get('/', async (req, res) => {
  try {
    const {
      sort_by = 'mean_time_ms',
      sort_dir = 'desc',
      limit = 50,
      offset = 0,
      query_type,
      table_name,
      min_mean_time,
      application_name,
    } = req.query;

    const validSortColumns = [
      'call_count',
      'mean_time_ms',
      'total_time_ms',
      'stddev_time_ms',
      'min_time_ms',
      'max_time_ms',
      'last_seen',
      'query_type',
      'table_name',
    ];

    const sortColumn = validSortColumns.includes(sort_by) ? sort_by : 'mean_time_ms';
    const sortDirection = sort_dir.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const where = {};
    if (query_type) where.query_type = query_type.toUpperCase();
    if (table_name) where.table_name = table_name;
    if (application_name) where.application_name = application_name;
    if (min_mean_time) {
      where.mean_time_ms = { [Op.gte]: Number(min_mean_time) };
    }

    const { count, rows } = await SlowQuery.findAndCountAll({
      where,
      order: [[sortColumn, sortDirection]],
      limit: Math.min(Number(limit), 200),
      offset: Math.max(0, Number(offset)),
    });

    res.json({
      success: true,
      data: {
        queries: rows.map((q) => ({
          id: q.id,
          normalized_query: q.normalized_query,
          query_type: q.query_type,
          table_name: q.table_name,
          application_name: q.application_name,
          call_count: q.call_count,
          mean_time_ms: q.mean_time_ms,
          total_time_ms: q.total_time_ms,
          stddev_time_ms: q.stddev_time_ms,
          min_time_ms: q.min_time_ms,
          max_time_ms: q.max_time_ms,
          last_seen: q.last_seen,
          first_seen: q.first_seen,
        })),
        total: count,
        limit: Number(limit),
        offset: Number(offset),
      },
    });
  } catch (error) {
    console.error('Error fetching slow queries:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/slow-queries/top
 * Top 5 slow queries with EXPLAIN ANALYZE plans.
 */
router.get('/top', async (req, res) => {
  try {
    const topQueries = await SlowQuery.findAll({
      order: [['mean_time_ms', 'DESC']],
      limit: 5,
    });

    const results = [];

    for (const query of topQueries) {
      let planData = query.plan_data;

      // Attempt to capture EXPLAIN plan if not cached (use raw_query if available)
      if (!planData) {
        const explainTarget = query.raw_query || query.normalized_query;
        if (query.raw_query) {
          try {
            const explainResult = await sequelize.query(
              `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.raw_query}`,
              { type: sequelize.QueryTypes.SELECT }
            );
            planData = explainResult;
            await query.update({ plan_data: planData });
          } catch (err) {
            planData = { error: 'Could not execute EXPLAIN on this query: ' + err.message };
          }
        } else {
          planData = { error: 'Raw query not available for EXPLAIN analysis' };
        }
      }

      results.push({
        id: query.id,
        normalized_query: query.normalized_query,
        query_type: query.query_type,
        table_name: query.table_name,
        call_count: query.call_count,
        mean_time_ms: query.mean_time_ms,
        total_time_ms: query.total_time_ms,
        max_time_ms: query.max_time_ms,
        plan: planData,
      });
    }

    res.json({ success: true, data: results });
  } catch (error) {
    console.error('Error fetching top slow queries:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/slow-queries/:id/plan
 * EXPLAIN ANALYZE plan viewer for a specific query.
 */
router.get('/:id/plan', async (req, res) => {
  try {
    const query = await SlowQuery.findByPk(req.params.id);
    if (!query) {
      return res.status(404).json({ success: false, error: 'Slow query not found' });
    }

    let planData = query.plan_data;

    if (!planData) {
      const explainTarget = query.raw_query || query.normalized_query;
      if (query.raw_query) {
        try {
          const explainResult = await sequelize.query(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.raw_query}`,
            { type: sequelize.QueryTypes.SELECT }
          );
          planData = explainResult;
          await query.update({ plan_data: planData });
        } catch (err) {
          planData = { error: 'Could not execute EXPLAIN on this query: ' + err.message };
        }
      } else {
        planData = { error: 'Raw query not available for EXPLAIN analysis' };
      }
    }

    res.json({
      success: true,
      data: {
        id: query.id,
        normalized_query: query.normalized_query,
        query_type: query.query_type,
        table_name: query.table_name,
        mean_time_ms: query.mean_time_ms,
        plan: planData,
      },
    });
  } catch (error) {
    console.error('Error fetching query plan:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/slow-queries/alerts
 * Alert history with filtering.
 */
router.get('/alerts', async (req, res) => {
  try {
    const {
      limit = 50,
      offset = 0,
      severity,
      acknowledged,
    } = req.query;

    const where = {};
    if (severity) where.severity = severity;
    if (acknowledged !== undefined) {
      where.acknowledged = acknowledged === 'true';
    }

    const { count, rows } = await SlowQueryAlert.findAndCountAll({
      where,
      include: [{
        model: SlowQuery,
        as: 'slowQuery',
        attributes: ['normalized_query', 'query_type', 'table_name', 'mean_time_ms'],
      }],
      order: [['last_fired_at', 'DESC']],
      limit: Math.min(Number(limit), 200),
      offset: Math.max(0, Number(offset)),
    });

    res.json({
      success: true,
      data: {
        alerts: rows.map((a) => ({
          id: a.id,
          severity: a.severity,
          threshold_ms: a.threshold_ms,
          actual_mean_time_ms: a.actual_mean_time_ms,
          fire_count: a.fire_count,
          first_fired_at: a.first_fired_at,
          last_fired_at: a.last_fired_at,
          acknowledged: a.acknowledged,
          acknowledged_by: a.acknowledged_by,
          acknowledged_at: a.acknowledged_at,
          pagerduty_incident_id: a.pagerduty_incident_id,
          query: a.slowQuery ? {
            normalized_query: a.slowQuery.normalized_query,
            query_type: a.slowQuery.query_type,
            table_name: a.slowQuery.table_name,
            mean_time_ms: a.slowQuery.mean_time_ms,
          } : null,
        })),
        total: count,
        limit: Number(limit),
        offset: Number(offset),
      },
    });
  } catch (error) {
    console.error('Error fetching alerts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/slow-queries/alerts/:id/acknowledge
 * Acknowledge an alert.
 */
router.post('/alerts/:id/acknowledge', async (req, res) => {
  try {
    const { acknowledged_by } = req.body;
    if (!acknowledged_by) {
      return res.status(400).json({ success: false, error: 'acknowledged_by is required' });
    }

    const alert = await alertEngine.acknowledgeAlert(req.params.id, acknowledged_by);

    res.json({
      success: true,
      data: {
        id: alert.id,
        acknowledged: alert.acknowledged,
        acknowledged_by: alert.acknowledged_by,
        acknowledged_at: alert.acknowledged_at,
      },
    });
  } catch (error) {
    console.error('Error acknowledging alert:', error);
    const status = error.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/slow-queries/collect
 * Trigger a manual collection cycle.
 */
router.post('/collect', async (req, res) => {
  try {
    const result = await collector.collectOnce();
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Error collecting slow queries:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/slow-queries/stats
 * Get alert statistics and health.
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await alertEngine.getAlertStats();

    const topSlowQuery = await SlowQuery.findOne({
      order: [['mean_time_ms', 'DESC']],
    });

    res.json({
      success: true,
      data: {
        ...stats,
        totalTrackedQueries: await SlowQuery.count(),
        slowestQuery: topSlowQuery ? {
          mean_time_ms: topSlowQuery.mean_time_ms,
          query_type: topSlowQuery.query_type,
          table_name: topSlowQuery.table_name,
        } : null,
      },
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
