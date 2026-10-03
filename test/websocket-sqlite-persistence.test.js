import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { SqliteBufferedWebSocketClient } from '../src/api/sqlite-buffered-client.js';

describe('Persistent WebSocket Queue: Crash Survival & Reconnect Recovery', () => {
  let tempDir;
  let dbFilePath;
  let server;
  let wss;
  let serverPort;
  let closedPort;
  const receivedMessages = [];

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-queue-test-'));
    dbFilePath = path.join(tempDir, 'offline-queue.db');

    // Reserve then release a port so it is reliably connection-refused.
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    closedPort = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
  });

  after(async () => {
    if (wss) {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('preserves queued actions across a restart and drains them on reconnect', async () => {
    // Phase 1 -- client 1 runs while the server is unreachable.
    let client1 = new SqliteBufferedWebSocketClient({
      url: `ws://127.0.0.1:${closedPort}/stream`,
      dbPath: dbFilePath,
      reconnectIntervalMs: 20,
    });

    client1.connect();
    assert.equal(client1.isOpen(), false);

    const res1 = client1.send({ action: 'REGISTER_IP', asset_id: 101, hash: '0xabc1' });
    const res2 = client1.send({ action: 'LOCK_ESCROW', escrow_id: 202, amount: '500' });
    const res3 = client1.send({ action: 'RELEASE_MILESTONE', escrow_id: 202, milestone: 1 });

    assert.equal(res1.sentImmediately, false);
    assert.equal(res2.sentImmediately, false);
    assert.equal(res3.sentImmediately, false);
    assert.equal(client1.getQueueSize(), 3);

    // Phase 2 -- simulate an abrupt process death.
    client1.close();
    client1 = null;

    assert.ok(fs.existsSync(dbFilePath), 'database file must persist on disk');

    // Phase 3 -- bring the server up.
    server = http.createServer();
    wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => receivedMessages.push(JSON.parse(raw.toString())));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    serverPort = server.address().port;

    // Phase 4 -- new client boots against the same database file.
    const client2 = new SqliteBufferedWebSocketClient({
      url: `ws://127.0.0.1:${serverPort}/stream`,
      dbPath: dbFilePath,
      reconnectIntervalMs: 20,
    });

    assert.equal(client2.getQueueSize(), 3, 'queue must survive the restart');

    const flushPromise = new Promise((resolve) => {
      client2.onQueueFlushed = (count) => resolve(count);
    });

    client2.connect();
    const flushedCount = await flushPromise;
    assert.equal(flushedCount, 3);
    assert.equal(client2.getQueueSize(), 0);

    await new Promise((resolve) => setTimeout(resolve, 80));

    // Phase 5 -- FIFO integrity and payload fidelity.
    assert.equal(receivedMessages.length, 3);
    assert.deepEqual(receivedMessages[0], { action: 'REGISTER_IP', asset_id: 101, hash: '0xabc1' });
    assert.deepEqual(receivedMessages[1], { action: 'LOCK_ESCROW', escrow_id: 202, amount: '500' });
    assert.deepEqual(receivedMessages[2], {
      action: 'RELEASE_MILESTONE',
      escrow_id: 202,
      milestone: 1,
    });

    client2.close();
  });
});
