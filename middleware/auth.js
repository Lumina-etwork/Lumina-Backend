const crypto = require('crypto');
const { Keypair } = require('stellar-sdk');

class AuthMiddleware {
  constructor() {
    this.signatureRequired = process.env.ADMIN_SIGNATURE_REQUIRED === 'true';
  }

  // Middleware to verify payload signatures for sensitive operations
  verifyPayloadSignature() {
    return async (req, res, next) => {
      if (!this.signatureRequired) {
        return next();
      }

      try {
        const signature = req.headers['x-stellar-signature'];
        const publicKey = req.headers['x-stellar-public-key'];
        const timestamp = req.headers['x-timestamp'];

        if (!signature || !publicKey || !timestamp) {
          return res.status(401).json({
            error: 'Missing required authentication headers',
            required: ['x-stellar-signature', 'x-stellar-public-key', 'x-timestamp']
          });
        }

        // Check for replay attacks (timestamp should be within 5 minutes)
        const now = Date.now();
        const requestTime = parseInt(timestamp);
        if (Math.abs(now - requestTime) > 5 * 60 * 1000) {
          return res.status(401).json({
            error: 'Request timestamp is too old or in the future'
          });
        }

        // Create the payload hash
        const payload = JSON.stringify(req.body);
        const message = `${timestamp}.${payload}`;
        const messageHash = crypto.createHash('sha256').update(message).digest();

        // Verify the signature
        const isValidSignature = this.verifyStellarSignature(
          publicKey,
          signature,
          messageHash
        );

        if (!isValidSignature) {
          return res.status(401).json({
            error: 'Invalid signature verification'
          });
        }

        // Attach verified public key to request for downstream use
        req.verifiedPublicKey = publicKey;
        next();

      } catch (error) {
        console.error('Signature verification error:', error);
        return res.status(401).json({
          error: 'Signature verification failed',
          details: error.message
        });
      }
    };
  }

  // Verify Stellar signature using Ed25519
  verifyStellarSignature(publicKey, signatureHex, messageHash) {
    try {
      const signature = Buffer.from(signatureHex, 'hex');
      const keypair = Keypair.fromPublicKey(publicKey);
      
      // Stellar uses Ed25519 signatures
      return keypair.verify(messageHash, signature);
    } catch (error) {
      console.error('Stellar signature verification error:', error);
      return false;
    }
  }

  // Generate signature for client-side testing
  generateSignature(privateKey, payload, timestamp = null) {
    const keypair = Keypair.fromSecret(privateKey);
    const ts = timestamp || Date.now().toString();
    const message = `${ts}.${JSON.stringify(payload)}`;
    const messageHash = crypto.createHash('sha256').update(message).digest();
    const signature = keypair.sign(messageHash);
    
    return {
      signature: signature.toString('hex'),
      publicKey: keypair.publicKey(),
      timestamp: ts
    };
  }

  // Middleware for admin-only routes
  requireAdmin() {
    return (req, res, next) => {
      // This would typically check against a database of admin users
      // For now, we'll check if the verified public key is in an environment variable
      const adminPublicKeys = process.env.ADMIN_PUBLIC_KEYS?.split(',') || [];
      
      if (!req.verifiedPublicKey || !adminPublicKeys.includes(req.verifiedPublicKey)) {
        return res.status(403).json({
          error: 'Admin access required',
          verifiedKey: req.verifiedPublicKey
        });
      }
      
      next();
    };
  }

  // Rate limiting for sensitive operations
  rateLimitSensitive(maxRequests = 5, windowMs = 60000) {
    const requests = new Map();
    
    return (req, res, next) => {
      const key = req.verifiedPublicKey || req.ip;
      const now = Date.now();
      const windowStart = now - windowMs;
      
      // Clean old entries
      for (const [ip, timestamps] of requests.entries()) {
        requests.set(ip, timestamps.filter(t => t > windowStart));
        if (requests.get(ip).length === 0) {
          requests.delete(ip);
        }
      }
      
      // Check current requests
      const userRequests = requests.get(key) || [];
      if (userRequests.length >= maxRequests) {
        return res.status(429).json({
          error: 'Too many sensitive operations',
          limit: maxRequests,
          window: windowMs / 1000
        });
      }
      
      // Add current request
      userRequests.push(now);
      requests.set(key, userRequests);
      
      next();
    };
  }
}

module.exports = new AuthMiddleware();
