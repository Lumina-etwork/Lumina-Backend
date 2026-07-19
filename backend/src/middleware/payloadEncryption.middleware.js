const { decryptSensitiveFields, encryptSensitiveFields } = require('../util/payloadEncryption');

function payloadFieldEncryptionMiddleware(options = {}) {
  const enabled = options.enabled ?? process.env.PAYLOAD_FIELD_ENCRYPTION_ENABLED === 'true';

  return (req, res, next) => {
    if (!enabled) return next();

    try {
      if (req.body && typeof req.body === 'object') {
        req.body = decryptSensitiveFields(req.body, options);
      }

      const originalJson = res.json.bind(res);
      res.json = (body) => originalJson(encryptSensitiveFields(body, options));
      return next();
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid encrypted payload field',
      });
    }
  };
}

module.exports = { payloadFieldEncryptionMiddleware };
