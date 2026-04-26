const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');

// Generate signature for testing purposes
router.post('/generate-signature', (req, res) => {
  try {
    const { privateKey, payload, timestamp, nonce } = req.body;
    
    if (!privateKey || !payload) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['privateKey', 'payload']
      });
    }

    const signatureData = authMiddleware.generateSignature(privateKey, payload, timestamp, nonce);
    
    res.json({
      success: true,
      signatureData,
      usage: {
        headers: {
          'x-stellar-signature': signatureData.signature,
          'x-stellar-public-key': signatureData.publicKey,
          'x-timestamp': signatureData.timestamp,
          'x-nonce': signatureData.nonce
        }
      }
    });

  } catch (error) {
    console.error('Generate signature error:', error);
    res.status(500).json({
      error: 'Failed to generate signature',
      details: error.message
    });
  }
});

// Verify signature manually for testing
router.post('/verify-signature', (req, res) => {
  try {
    const { publicKey, signature, payload, timestamp, nonce } = req.body;
    
    if (!publicKey || !signature || !payload || !timestamp) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['publicKey', 'signature', 'payload', 'timestamp']
      });
    }

    const isValid = authMiddleware.verifySignatureManually(publicKey, signature, payload, timestamp, nonce);
    
    res.json({
      success: true,
      isValid,
      message: isValid ? 'Signature is valid' : 'Signature is invalid'
    });

  } catch (error) {
    console.error('Verify signature error:', error);
    res.status(500).json({
      error: 'Failed to verify signature',
      details: error.message
    });
  }
});

// Test signature verification middleware
router.post('/test-middleware', authMiddleware.verifyPayloadSignature(), (req, res) => {
  res.json({
    success: true,
    message: 'Signature verification passed',
    verifiedPublicKey: req.verifiedPublicKey,
    signatureTimestamp: req.signatureTimestamp,
    signatureNonce: req.signatureNonce
  });
});

// Get auth configuration
router.get('/config', (req, res) => {
  res.json({
    signatureRequired: authMiddleware.signatureRequired,
    maxNonceAge: authMiddleware.maxNonceAge,
    nonceCacheSize: authMiddleware.nonceCache.size
  });
});

module.exports = router;
