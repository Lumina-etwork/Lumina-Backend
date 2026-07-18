const express = require('express');
const { RuntimeConfigAuditService } = require('../services/runtimeConfigAuditService');
const metricsService = require('../services/metricsService');

const router = express.Router();
const runtimeConfigAuditService = new RuntimeConfigAuditService({ metrics: metricsService });

router.get('/audit/runtime-config', (req, res) => {
  const result = runtimeConfigAuditService.audit();
  res.status(result.status === 'healthy' ? 200 : 409).json({ success: result.status === 'healthy', data: result });
});

router.get('/audit/runtime-config/last', (req, res) => {
  const result = runtimeConfigAuditService.getLastAudit();
  if (!result) {
    return res.status(404).json({ success: false, error: 'No runtime configuration audit has been run' });
  }
  return res.json({ success: result.status === 'healthy', data: result });
});

router.post('/audit/runtime-config/baseline', (req, res) => {
  const baseline = runtimeConfigAuditService.setBaseline();
  res.status(201).json({ success: true, data: { baseline } });
});

module.exports = { router, runtimeConfigAuditService };
