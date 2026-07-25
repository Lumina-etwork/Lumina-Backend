const http = require('http');
const { getSequelize } = require('./database/connection');

const SHUTDOWN_TIMEOUT_MS = 60_000;
const DRAIN_TIMEOUT_MS = 30_000;
const PERSIST_TIMEOUT_MS = 10_000;

let isShuttingDown = false;
/** @type {Set<import('net').Socket>} */
let activeConnections = new Set();
let _exitFn = typeof process.exit === 'function' ? process.exit : (code) => {};

function trackConnection(server) {
  server.on('connection', (socket) => {
    activeConnections.add(socket);
    socket.on('close', () => {
      activeConnections.delete(socket);
    });
  });
}

async function drainConnections(server, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(false);
    }, timeoutMs);

    try {
      server.close(() => {
        clearTimeout(timeout);
        resolve(true);
      });
    } catch (err) {
      clearTimeout(timeout);
      resolve(true);
    }

    for (const socket of activeConnections) {
      try { socket.destroy(); } catch (e) { /* ignore */ }
    }
    activeConnections.clear();
  });
}

async function persistState(timeoutMs) {
  if (process.env.NODE_ENV === 'test') {
    return false;
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(false);
    }, timeoutMs);

    (async () => {
      try {
        const sequelize = await getSequelize();
        if (sequelize) {
          const queryInterface = sequelize.getQueryInterface();
          await sequelize.transaction(async (t) => {
            await sequelize.query('CHECKPOINT', { transaction: t });
          });
        }
        clearTimeout(timeout);
        resolve(true);
      } catch (err) {
        clearTimeout(timeout);
        resolve(false);
      }
    })();
  });
}

async function shutdown(server, options = {}) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  const {
    drainTimeoutMs = DRAIN_TIMEOUT_MS,
    persistTimeoutMs = PERSIST_TIMEOUT_MS,
    totalTimeoutMs = SHUTDOWN_TIMEOUT_MS,
    onPhase = () => {},
    onError = () => {},
    services = [],
  } = options;

  const startTime = Date.now();
  const totalTimeout = setTimeout(() => {
    _exitFn(1);
  }, totalTimeoutMs);

  try {
    // Phase 1: Stop accepting
    onPhase('stopping');
    console.log('[GracefulShutdown] Phase 1: Stopping new connections');

    // Phase 2: Drain
    onPhase('draining');
    const drainStarted = Date.now();
    console.log('[GracefulShutdown] Phase 2: Draining connections');

    // Stop health check endpoint
    if (server.healthCheckHandler) {
      server.healthCheckHandler(503);
    }

    for (const service of services) {
      try {
        if (typeof service.stop === 'function') {
          service.stop();
        }
      } catch (err) {
        onError(err);
      }
    }

    const drained = await drainConnections(server, drainTimeoutMs);
    if (!drained) {
      console.warn('[GracefulShutdown] Drain timeout reached, forcing close');
    }

    // Phase 3: Persist
    onPhase('persisting');
    const persistStarted = Date.now();
    console.log('[GracefulShutdown] Phase 3: Persisting state');

    const persisted = await persistState(persistTimeoutMs);
    if (!persisted) {
      console.warn('[GracefulShutdown] Persist timeout reached, exiting anyway');
    }

    // Phase 4: Exit
    onPhase('exiting');
    console.log('[GracefulShutdown] Phase 4: Exiting');

    clearTimeout(totalTimeout);
    _exitFn(0);
  } catch (err) {
    onError(err);
    clearTimeout(totalTimeout);
    _exitFn(1);
  }
}

function installShutdownHandler(server, options = {}) {
  trackConnection(server);

  const sigtermHandler = async () => {
    console.log('[GracefulShutdown] Received SIGTERM, starting shutdown sequence');
    await shutdown(server, options);
  };
  const sigintHandler = async () => {
    console.log('[GracefulShutdown] Received SIGINT, starting shutdown sequence');
    await shutdown(server, options);
  };

  process.on('SIGTERM', sigtermHandler);
  process.on('SIGINT', sigintHandler);

  return () => {
    process.removeListener('SIGTERM', sigtermHandler);
    process.removeListener('SIGINT', sigintHandler);
  };
}

module.exports = {
  shutdown,
  installShutdownHandler,
  trackConnection,
  drainConnections,
  persistState,
  __forTest: {
    setExitFn: (fn) => { _exitFn = fn; },
    resetShuttingDown: () => { isShuttingDown = false; },
    resetActiveConnections: () => { activeConnections = new Set(); },
  },
};
