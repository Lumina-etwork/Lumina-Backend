const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const stellarService = require('../services/stellarService');

// Apply signature verification to all admin routes
router.use(authMiddleware.verifyPayloadSignature());

// Add multi-sig member - requires signature verification
router.post('/multisig/add-member', authMiddleware.requireAdmin(), authMiddleware.rateLimitSensitive(), async (req, res) => {
  try {
    const { accountId, weight, signerType } = req.body;
    
    if (!accountId || weight === undefined) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['accountId', 'weight']
      });
    }

    // Validate Stellar account
    try {
      await stellarService.getAccount(accountId);
    } catch (error) {
      return res.status(400).json({
        error: 'Invalid Stellar account',
        details: error.message
      });
    }

    // Here you would typically update your database
    // For demonstration, we'll just return success
    res.json({
      success: true,
      message: 'Multi-sig member added successfully',
      data: {
        accountId,
        weight,
        signerType: signerType || 'ed25519_public_key',
        addedBy: req.verifiedPublicKey,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Add multi-sig member error:', error);
    res.status(500).json({
      error: 'Failed to add multi-sig member',
      details: error.message
    });
  }
});

// Remove multi-sig member - requires signature verification
router.post('/multisig/remove-member', authMiddleware.requireAdmin(), authMiddleware.rateLimitSensitive(), async (req, res) => {
  try {
    const { accountId } = req.body;
    
    if (!accountId) {
      return res.status(400).json({
        error: 'Missing required field: accountId'
      });
    }

    res.json({
      success: true,
      message: 'Multi-sig member removed successfully',
      data: {
        accountId,
        removedBy: req.verifiedPublicKey,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Remove multi-sig member error:', error);
    res.status(500).json({
      error: 'Failed to remove multi-sig member',
      details: error.message
    });
  }
});

// Update vesting schedule - requires signature verification
router.post('/vesting/update-schedule', authMiddleware.requireAdmin(), authMiddleware.rateLimitSensitive(), async (req, res) => {
  try {
    const { scheduleId, newSchedule } = req.body;
    
    if (!scheduleId || !newSchedule) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['scheduleId', 'newSchedule']
      });
    }

    // Validate new schedule structure
    const requiredFields = ['totalAmount', 'cliffPeriod', 'vestingPeriod', 'interval'];
    for (const field of requiredFields) {
      if (!newSchedule[field]) {
        return res.status(400).json({
          error: `Missing required field in newSchedule: ${field}`
        });
      }
    }

    res.json({
      success: true,
      message: 'Vesting schedule updated successfully',
      data: {
        scheduleId,
        newSchedule,
        updatedBy: req.verifiedPublicKey,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Update vesting schedule error:', error);
    res.status(500).json({
      error: 'Failed to update vesting schedule',
      details: error.message
    });
  }
});

// Emergency pause - requires signature verification
router.post('/emergency/pause', authMiddleware.requireAdmin(), authMiddleware.rateLimitSensitive(1, 60000), async (req, res) => {
  try {
    const { reason } = req.body;
    
    res.json({
      success: true,
      message: 'Emergency pause activated',
      data: {
        paused: true,
        reason: reason || 'Emergency maintenance',
        pausedBy: req.verifiedPublicKey,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Emergency pause error:', error);
    res.status(500).json({
      error: 'Failed to activate emergency pause',
      details: error.message
    });
  }
});

// Get admin status
router.get('/status', authMiddleware.requireAdmin(), async (req, res) => {
  try {
    res.json({
      authenticated: true,
      publicKey: req.verifiedPublicKey,
      stellarEndpoints: stellarService.getEndpointStatus(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Admin status error:', error);
    res.status(500).json({
      error: 'Failed to get admin status',
      details: error.message
    });
  }
});

module.exports = router;
