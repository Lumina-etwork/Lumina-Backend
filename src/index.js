import http from 'node:http';
import cors from 'cors';
import express from 'express';
import dotenv from 'dotenv';

import { initDatabase } from './db/schema.js';
import { createRouter } from './api/routes.js';
import { initWebSocketServer } from './api/websocket.js';
import { IdempotencyEngine } from './api/idempotency-engine.js';
import { createPoller } from './indexer/poller.js';

dotenv.config();

const PORT = Number(process.env.PORT || 4000);
const RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org:443';
const CONTRACT_ID =
  process.env.CONTRACT_ID || 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const DB_PATH = process.env.DB_PATH || './data/lumina.db';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 2000);

export async function startServer({
  port = PORT,
  dbPath = DB_PATH,
  idempotencyDbPath = dbPath === ':memory:' ? ':memory:' : './data/idempotency.db',
  rpcUrl = RPC_URL,
  contractId = CONTRACT_ID,
  pollIntervalMs = POLL_INTERVAL_MS,
  logger = console,
} = {}) {
  const db = initDatabase(dbPath);

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(createRouter({ db, contractId }));

  const server = http.createServer(app);
  const idempotencyEngine = new IdempotencyEngine({ dbPath: idempotencyDbPath, logger });
  const { broadcast, wss } = initWebSocketServer(server, {
    idempotencyEngine,
    businessHandler: async (_data, { msgId }) => {
      logger.log?.(`[lumina] inbound frame ${msgId}`);
    },
  });

  const poller = createPoller({
    db,
    rpcUrl,
    contractId,
    pollIntervalMs,
    broadcast,
    logger,
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });

  await poller.start();

  const shutdown = async (signal) => {
    logger.log?.(`[lumina] ${signal} received, shutting down`);
    await poller.stop();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    idempotencyEngine.close();
    db.close();
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return { app, server, db, poller, wss, idempotencyEngine, port: server.address().port };
}

// Only auto-start when executed directly, so tests can import startServer().
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  startServer()
    .then(({ port }) => {
      console.log(`[lumina] indexer listening on http://localhost:${port}`);
      console.log(`[lumina] soroban rpc: ${RPC_URL}`);
      console.log(`[lumina] contract: ${CONTRACT_ID}`);
    })
    .catch((error) => {
      console.error('[lumina] failed to start:', error);
      process.exit(1);
    });
}
