const express = require('express');
const AuditService = require('../services/auditService');

const router = express.Router();

router.get('/verify', async (req, res) => {
  try {
    const result = await AuditService.verifyHashChain({
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit,
    });

    res.status(result.valid ? 200 : 409).json({
      success: result.valid,
      data: result,
    });
  } catch (error) {
    console.error('[AuditTrail] Verification failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;
