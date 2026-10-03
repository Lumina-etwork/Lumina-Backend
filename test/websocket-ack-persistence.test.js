import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { AckBufferedWebSocketClient } from '../src/api/ack-buffered-client.js';

describe('ACK-Confirmed WebSocket Persistence', () => {
  let tempDir;
  let dbFilePath;
  let server;
  let wss;
  let serverPort;

  function createServer(onMessageHandler) {
    server = http.createServer();
    wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        try {
          onMessageHandler(ws, JSON.parse(raw.toString()));
        } catch {
          /* ignore malformed client frames */
        }
      });
    });

    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        resolve(serverPort);
      });
    });
  }

  async function closeServer() {
    if (wss) {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
      wss = null;
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-ack-test-'));
    dbFilePath = path.join(tempDir, 'ack-queue.db');
  });

  afterEach(async () => {
    await closeServer();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('retains the row until the server ACKs, then removes it', async () => {
    await createServer((ws, message) => {
      ws.send(JSON.stringify({ type: 'ACK', msg_id: message.msg_id }));
    });

    const client = new AckBufferedWebSocketClient({
      url: `ws://127.0.0.1:${serverPort}`,
      dbPath: dbFilePath,
    });

    await new Promise((resolve) => {
      client.onOpen = resolve;
      client.connect();
    });

    const ackPromise = new Promise((resolve) => {
      client.onAckProcessed = (msgId, wasDeleted) => resolve({ msgId, wasDeleted });
    });

    const msgId = client.send({ action: 'REGISTER_ASSET', asset_id: 88 });

    // send() is synchronous, so the row exists as IN_FLIGHT right now.
    const storedBeforeAck = client.getMessage(msgId);
    assert.ok(storedBeforeAck, 'row must exist while in flight');
    assert.equal(storedBeforeAck.status, 'IN_FLIGHT');

    const { msgId: ackedId, wasDeleted } = await ackPromise;
    assert.equal(ackedId, msgId);
    assert.equal(wasDeleted, true);

    assert.equal(client.getMessage(msgId), undefined, 'row deleted after ACK');
    assert.equal(client.getQueueSize(), 0);

    client.close();
  });

  it('preserves an unacknowledged message across reconnect and drains it on delayed ACK', async () => {
    const receivedDeliveries = [];
    let deliveries = 0;

    await createServer((ws, message) => {
      deliveries += 1;
      receivedDeliveries.push(message);

      if (deliveries === 1) {
        ws.terminate(); // drop without ACKing
      } else {
        ws.send(JSON.stringify({ type: 'ACK', msg_id: message.msg_id }));
      }
    });

    const client = new AckBufferedWebSocketClient({
      url: `ws://127.0.0.1:${serverPort}`,
      dbPath: dbFilePath,
      reconnectIntervalMs: 40,
    });

    await new Promise((resolve) => {
      client.onOpen = resolve;
      client.connect();
    });

    const finalAckPromise = new Promise((resolve) => {
      client.onAckProcessed = (msgId) => resolve(msgId);
    });

    const msgId = client.send({ action: 'SETTLE_ESCROW', escrow_id: 104 });
    const confirmedMsgId = await finalAckPromise;
    assert.equal(confirmedMsgId, msgId);

    assert.equal(receivedDeliveries.length, 2, 'message must be delivered twice');
    assert.equal(receivedDeliveries[0].msg_id, msgId);
    assert.equal(receivedDeliveries[1].msg_id, msgId);
    assert.equal(client.getQueueSize(), 0);

    client.close();
  });

  it('deletes only acknowledged rows and keeps unacknowledged ones queued', async () => {
    await createServer((ws, message) => {
      if (message.data.seq === 1) {
        ws.send(JSON.stringify({ type: 'ACK', msg_id: message.msg_id }));
      }
    });

    const client = new AckBufferedWebSocketClient({
      url: `ws://127.0.0.1:${serverPort}`,
      dbPath: dbFilePath,
      ackTimeoutMs: 5000, // long enough not to interfere with this assertion
    });

    await new Promise((resolve) => {
      client.onOpen = resolve;
      client.connect();
    });

    const ackPromise = new Promise((resolve) => {
      client.onAckProcessed = (msgId) => resolve(msgId);
    });

    const id1 = client.send({ seq: 1, payload: 'alpha' });
    const id2 = client.send({ seq: 2, payload: 'beta' });

    await ackPromise;
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(client.getMessage(id1), undefined, 'ACKed message is removed');

    const remaining = client.getMessage(id2);
    assert.ok(remaining, 'unacknowledged message stays in the database');
    assert.equal(remaining.status, 'IN_FLIGHT');
    assert.equal(client.getQueueSize(), 1);

    client.close();
  });
});
