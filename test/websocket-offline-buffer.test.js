import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { BufferedWebSocketClient } from '../src/api/buffered-client.js';

describe('WebSocket Offline Message Buffering & Reconnect Flush', () => {
  let server;
  let wss;
  let serverPort;
  let receivedServerMessages = [];

  async function startServer(port = 0) {
    receivedServerMessages = [];
    server = http.createServer();
    wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        receivedServerMessages.push(JSON.parse(raw.toString()));
      });
    });

    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    serverPort = server.address().port;
    return serverPort;
  }

  async function stopServer() {
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

  beforeEach(async () => {
    await startServer();
  });

  afterEach(async () => {
    await stopServer();
  });

  it('delivers messages immediately without enqueuing when connected', async () => {
    const client = new BufferedWebSocketClient({
      url: `ws://127.0.0.1:${serverPort}`,
      reconnectIntervalMs: 50,
    });

    await new Promise((resolve) => {
      client.onOpen = resolve;
      client.connect();
    });

    const sentDirectly = client.send({ type: 'SUBSCRIBE', channel: 'telemetry' });
    assert.equal(sentDirectly, true);
    assert.equal(client.getQueueSize(), 0);

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(receivedServerMessages.length, 1);
    assert.deepEqual(receivedServerMessages[0], { type: 'SUBSCRIBE', channel: 'telemetry' });

    client.close();
  });

  it('buffers messages in memory when the socket is disconnected', () => {
    const client = new BufferedWebSocketClient({
      url: 'ws://127.0.0.1:9/stream',
      reconnectIntervalMs: 100,
    });

    client.connect();
    assert.equal(client.isOpen(), false);

    client.send({ id: 1, action: 'ANCHOR_REQUEST' });
    client.send({ id: 2, action: 'TELEMETRY_FRAME' });

    assert.equal(client.getQueueSize(), 2);
    client.close();
  });

  it('drains buffered offline messages strictly FIFO on reconnect', async () => {
    const port = serverPort;
    const client = new BufferedWebSocketClient({
      url: `ws://127.0.0.1:${port}`,
      reconnectIntervalMs: 50,
    });

    await new Promise((resolve) => {
      client.onOpen = resolve;
      client.connect();
    });

    // Kill the server to force the client offline.
    await stopServer();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(client.isOpen(), false);

    const testItems = [
      { seq: 1, payload: 'tx_hash_alpha' },
      { seq: 2, payload: 'tx_hash_beta' },
      { seq: 3, payload: 'tx_hash_gamma' },
    ];
    for (const item of testItems) client.send(item);
    assert.equal(client.getQueueSize(), 3);

    const flushPromise = new Promise((resolve) => {
      client.onQueueFlushed = (count) => resolve(count);
    });

    await startServer(port);

    const flushedCount = await flushPromise;
    assert.equal(flushedCount, 3);
    assert.equal(client.getQueueSize(), 0);

    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(receivedServerMessages.length, 3);
    assert.equal(receivedServerMessages[0].seq, 1);
    assert.equal(receivedServerMessages[1].seq, 2);
    assert.equal(receivedServerMessages[2].seq, 3);

    client.close();
  });

  it('enforces maxQueueSize and purges the oldest entries', () => {
    const dropped = [];
    const client = new BufferedWebSocketClient({
      url: 'ws://127.0.0.1:9/stream',
      maxQueueSize: 3,
      dropStrategy: 'drop-oldest',
    });

    client.onMessageDropped = (msg) => dropped.push(JSON.parse(msg));

    client.send({ id: 101 });
    client.send({ id: 102 });
    client.send({ id: 103 });
    assert.equal(client.getQueueSize(), 3);

    client.send({ id: 104 });
    assert.equal(client.getQueueSize(), 3);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].id, 101);

    client.send({ id: 105 });
    assert.equal(client.getQueueSize(), 3);
    assert.equal(dropped.length, 2);
    assert.equal(dropped[1].id, 102);

    const remainingIds = client.offlineQueue.map((item) => JSON.parse(item).id);
    assert.deepEqual(remainingIds, [103, 104, 105]);

    client.close();
  });

  it('rejects the newest entry under dropStrategy=reject-newest', () => {
    const dropped = [];
    const client = new BufferedWebSocketClient({
      url: 'ws://127.0.0.1:9/stream',
      maxQueueSize: 2,
      dropStrategy: 'reject-newest',
    });
    client.onMessageDropped = (msg) => dropped.push(JSON.parse(msg));

    client.send({ id: 1 });
    client.send({ id: 2 });
    const accepted = client.send({ id: 3 });

    assert.equal(accepted, false);
    assert.equal(client.getQueueSize(), 2);
    assert.deepEqual(client.offlineQueue.map((m) => JSON.parse(m).id), [1, 2]);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].id, 3);

    client.close();
  });
});
