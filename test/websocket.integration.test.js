import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

import { initWebSocketServer } from '../src/api/websocket.js';
import { IndexerPoller } from '../src/indexer/poller.js';
import { initDatabase } from '../src/db/schema.js';
import { decodeTopics, decodeEventData } from '../src/indexer/scval.js';
import {
  MOCK_CONTRACT_ID,
  MOCK_CREATOR,
  SAMPLE_HASH_HEX,
  ipAnchorEvent,
} from './helpers/fixtures.js';

const silent = { log() {}, warn() {}, error() {} };

describe('WebSocket /stream real-time broadcast', () => {
  let httpServer;
  let db;
  let broadcast;
  let wss;
  let port;

  before(async () => {
    db = initDatabase(':memory:');
    httpServer = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    ({ wss, broadcast } = initWebSocketServer(httpServer, { heartbeatIntervalMs: 60_000 }));
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    port = httpServer.address().port;
  });

  after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
    db?.close();
  });

  const openClient = async () => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/stream`);
    await new Promise((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });
    return client;
  };

  const nextFrame = (client, timeoutMs = 3000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for WS frame')), timeoutMs);
      client.once('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
      });
    });

  // A single ingest batch can emit several frames; wait for the one we care
  // about rather than assuming it is the first to arrive.
  const waitForFrame = (client, predicate, timeoutMs = 3000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        client.off('message', onMessage);
        reject(new Error('timed out waiting for matching WS frame'));
      }, timeoutMs);
      const onMessage = (data) => {
        const frame = JSON.parse(data.toString());
        if (predicate(frame)) {
          clearTimeout(timer);
          client.off('message', onMessage);
          resolve(frame);
        }
      };
      client.on('message', onMessage);
    });

  it('broadcasts an IP_ANCHOR frame when a Soroban event is ingested', async () => {
    const client = await openClient();
    const framePromise = nextFrame(client);

    // A fake server is enough: the poller is what turns events into frames.
    const poller = new IndexerPoller({
      db,
      server: null,
      contractId: MOCK_CONTRACT_ID,
      broadcast,
      logger: silent,
    });

    const applied = poller.ingestBatch([
      ipAnchorEvent({ assetId: 77, timestamp: 1700001234 }),
    ]);
    assert.equal(applied.length, 1);

    const frame = await framePromise;
    assert.equal(frame.type, 'IP_ANCHOR');
    assert.deepEqual(frame.data, {
      asset_id: 77,
      creator: MOCK_CREATOR,
      fingerprint: SAMPLE_HASH_HEX,
      timestamp: 1700001234,
    });

    client.close();
  });

  it('broadcasts a MILESTONE_RELEASED frame with the settlement status', async () => {
    const client = await openClient();
    const framePromise = waitForFrame(client, (f) => f.type === 'MILESTONE_RELEASED');

    // Seed an escrow, then release its milestones.
    const poller = new IndexerPoller({
      db,
      server: null,
      contractId: MOCK_CONTRACT_ID,
      broadcast,
      logger: silent,
    });

    const { escrowNewEvent, payRelEvent } = await import('./helpers/fixtures.js');
    poller.ingestBatch([
      escrowNewEvent({ escrowId: 555, totalAmount: 1000000000n, totalMilestones: 1 }),
    ]);
    poller.ingestBatch([
      payRelEvent({ escrowId: 555, payout: 1000000000n, completedMilestones: 1, ledger: 1100 }),
    ]);

    const frame = await framePromise;
    assert.equal(frame.type, 'MILESTONE_RELEASED');
    assert.equal(frame.data.escrow_id, 555);
    assert.equal(frame.data.payout_amount, '1000000000');
    assert.equal(frame.data.completed_milestones, 1);
    assert.equal(frame.data.status, 'settled');

    client.close();
  });

  it('rejects upgrades on any path other than /stream', async () => {
    const bad = new WebSocket(`ws://127.0.0.1:${port}/nope`);
    const err = await new Promise((resolve) => {
      bad.once('error', resolve);
      bad.once('open', () => resolve(null));
    });
    assert.ok(err, 'connection to a non-/stream path must fail');
  });

  it('decodes escrow_new topic/data shapes used by the indexer', async () => {
    const { escrowNewEvent } = await import('./helpers/fixtures.js');
    const evt = escrowNewEvent({ escrowId: 7, totalAmount: 500n, totalMilestones: 3 });

    const topics = decodeTopics(evt.topic);
    assert.equal(topics[0], 'escrow_new');

    const [escrowId, creator, totalAmount] = decodeEventData(evt.value);
    assert.equal(Number(escrowId), 7);
    assert.equal(creator, MOCK_CREATOR);
    assert.equal(totalAmount, 500n);
  });
});
