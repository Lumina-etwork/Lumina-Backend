const express = require('express');
const MultiRegionDrService = require('../services/multiRegionDrService');

const router = express.Router();
const service = new MultiRegionDrService();

router.post('/topology', (req, res) => {
  try {
    const topology = service.buildTopology(req.body.regions);
    res.json({ success: true, data: topology });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/failover-plan', (req, res) => {
  try {
    const topology = service.buildTopology(req.body.regions);
    const plan = service.createFailoverPlan(topology, req.body.healthSnapshots || []);
    res.json({ success: true, data: plan });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/health/evaluate', (req, res) => {
  try {
    const health = service.evaluateRegionHealth(req.body);
    res.json({ success: true, data: health });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
