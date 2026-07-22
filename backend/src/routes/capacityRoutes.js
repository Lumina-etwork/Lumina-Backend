const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const HistoricalUsageStore = require('../services/historicalUsageStore');
const CapacityProjectionService = require('../services/capacityProjectionService');

const router = express.Router();
const store = new HistoricalUsageStore();
const projectionService = new CapacityProjectionService({ store });

router.get('/metrics', authenticateToken, async (req, res) => {
  try {
    const metrics = await store.listMetrics();
    res.json({ metrics });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list metrics' });
  }
});

router.get('/metrics/:name', authenticateToken, async (req, res) => {
  try {
    const { name } = req.params;
    const { from, to, source, window: windowSeconds, labels: labelsQuery } = req.query;
    const labels = labelsQuery ? JSON.parse(labelsQuery) : undefined;

    const data = await store.getTimeSeries(name, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      source,
      labels,
      windowSeconds: windowSeconds ? parseInt(windowSeconds, 10) : undefined,
    });
    res.json({ metric_name: name, data_points: data.length, data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to query metric data' });
  }
});

router.get('/trends/:name', authenticateToken, async (req, res) => {
  try {
    const { name } = req.params;
    const { labels: labelsQuery, source } = req.query;
    const labels = labelsQuery ? JSON.parse(labelsQuery) : undefined;

    const summaries = await projectionService.getTrendSummary(name, { labels, source });
    res.json({ metric_name: name, summaries });
  } catch (error) {
    res.status(500).json({ error: 'Failed to compute trends' });
  }
});

router.get('/projections/:name', authenticateToken, async (req, res) => {
  try {
    const { name } = req.params;
    const { days_ahead, labels: labelsQuery, source } = req.query;
    const labels = labelsQuery ? JSON.parse(labelsQuery) : undefined;

    const projection = await projectionService.project(name, {
      daysAhead: days_ahead ? parseInt(days_ahead, 10) : 30,
      labels,
      source,
    });
    if (!projection) {
      return res.status(422).json({ error: 'Insufficient data for projection' });
    }
    res.json(projection);
  } catch (error) {
    res.status(500).json({ error: 'Failed to compute projection' });
  }
});

router.get('/exhaustion/:name', authenticateToken, async (req, res) => {
  try {
    const { name } = req.params;
    const { capacity_limit, labels: labelsQuery, source } = req.query;
    if (capacity_limit == null) {
      return res.status(400).json({ error: 'capacity_limit query parameter is required' });
    }
    const labels = labelsQuery ? JSON.parse(labelsQuery) : undefined;

    const result = await projectionService.daysUntilExhaustion(name, parseFloat(capacity_limit), { labels, source });
    res.json({ metric_name: name, ...result });
  } catch (error) {
    res.status(500).json({ error: 'Failed to compute exhaustion' });
  }
});

router.get('/report', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const metrics = await store.listMetrics();
    const report = {
      generated_at: new Date().toISOString(),
      metrics: [],
    };
    for (const m of metrics) {
      const trends = await projectionService.getTrendSummary(m.metric_name);
      report.metrics.push({
        metric_name: m.metric_name,
        sample_count: m.sample_count,
        first_seen: m.first_seen,
        last_seen: m.last_seen,
        trends,
      });
    }
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

router.get('/alerts', authenticateToken, async (req, res) => {
  try {
    const { labels: labelsQuery, source } = req.query;
    const labels = labelsQuery ? JSON.parse(labelsQuery) : undefined;
    const metrics = await store.listMetrics();
    const alerts = [];
    for (const m of metrics) {
      const state = await projectionService.getAlertState(m.metric_name, {
        warningThreshold: req.query.warning ? parseFloat(req.query.warning) : undefined,
        criticalThreshold: req.query.critical ? parseFloat(req.query.critical) : undefined,
        capacityLimit: req.query.capacity_limit ? parseFloat(req.query.capacity_limit) : undefined,
        labels,
        source,
      });
      if (state.level !== 'ok') alerts.push(state);
    }
    res.json({ alerts });
  } catch (error) {
    res.status(500).json({ error: 'Failed to evaluate alerts' });
  }
});

module.exports = router;
