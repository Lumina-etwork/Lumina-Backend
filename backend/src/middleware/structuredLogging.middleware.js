'use strict';

const logger = require('../utils/structuredLogger');

function structuredLoggingMiddleware(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const statusCode = res.statusCode;
    const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';

    // Derive url.scheme from the X-Forwarded-Proto header (set by reverse
    // proxies / load balancers) or fall back to the protocol reported by
    // Express (req.protocol), which itself honours the 'trust proxy' setting.
    const urlScheme = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();

    // Derive network.protocol.version from the raw HTTP version string
    // exposed by Node's IncomingMessage (e.g. '1.1' or '2.0').
    const networkProtocolVersion = req.httpVersion || undefined;

    logger[level]('HTTP request completed', {
      'http.request.method': req.method,
      'url.path': req.path,
      'url.scheme': urlScheme,
      'url.query': req.originalUrl && req.originalUrl.includes('?')
        ? req.originalUrl.split('?').slice(1).join('?')
        : undefined,
      'http.response.status_code': statusCode,
      'http.route': req.route && req.route.path ? req.route.path : undefined,
      'network.protocol.name': 'http',
      'network.protocol.version': networkProtocolVersion,
      'user_agent.original': req.get('user-agent'),
      'client.address': req.ip || (req.socket && req.socket.remoteAddress),
      'server.address': req.hostname,
      'server.port': req.socket && req.socket.localPort,
      'http.request.body.size': req.headers['content-length']
        ? Number(req.headers['content-length'])
        : undefined,
      'http.response.body.size': res.getHeader('content-length')
        ? Number(res.getHeader('content-length'))
        : undefined,
      'event.duration': Math.round(durationMs * 1e6),
      'lumina.request_id': req.traceId,
    });
  });

  next();
}

module.exports = { structuredLoggingMiddleware };
