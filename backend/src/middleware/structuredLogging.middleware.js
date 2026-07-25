'use strict';

const logger = require('../utils/structuredLogger');

function structuredLoggingMiddleware(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const statusCode = res.statusCode;
    const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';

    logger[level]('HTTP request completed', {
      'http.request.method': req.method,
      'url.path': req.path,
      'url.query': req.originalUrl && req.originalUrl.includes('?') ? req.originalUrl.split('?').slice(1).join('?') : undefined,
      'http.response.status_code': statusCode,
      'http.route': req.route && req.route.path ? req.route.path : undefined,
      'user_agent.original': req.get('user-agent'),
      'client.address': req.ip || (req.socket && req.socket.remoteAddress),
      'server.address': req.hostname,
      'server.port': req.socket && req.socket.localPort,
      'http.request.body.size': req.headers['content-length'] ? Number(req.headers['content-length']) : undefined,
      'http.response.body.size': res.getHeader('content-length') ? Number(res.getHeader('content-length')) : undefined,
      'event.duration': Math.round(durationMs * 1e6),
      'lumina.request_id': req.traceId,
    });
  });

  next();
}

module.exports = { structuredLoggingMiddleware };
