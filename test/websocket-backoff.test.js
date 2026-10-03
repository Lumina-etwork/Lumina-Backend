import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

/** Resilient client with exponential backoff (no jitter -- see jitter-client.js). */
class ResilientWebSocketClient {
  constructor({ url, initialDelayMs = 20, multiplier = 2, maxDelayMs = 200, maxRetries = 3 }) {
    this.url = url;
    this.initialDelayMs = initialDelayMs;
    this.multiplier = multiplier;
    this.maxDelayMs = maxDelayMs;
    this.maxRetries = maxRetries;

    this.retryCount = 0;
    this.isManuallyClosed = false;
    this.ws = null;
    this.reconnectTimer = null;

    this.attemptLog = [];
    this.onOpen = null;
    this.onReconnectScheduled = null;
    this.onMaxRetriesExceeded = null;
  }

  computeDelay(attempt) {
    const rawDelay = this.initialDelayMs * Math.pow(this.multiplier, attempt);
    return Math.min(rawDelay, this.maxDelayMs);
  }

  connect() {
    if (this.isManuallyClosed) return;

    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.retryCount = 0; // reset counter on successful connection
      this.onOpen?.();
    });

    this.ws.on('error', () => {
      // handled in 'close'
    });

    this.ws.on('close', () => {
      if (this.isManuallyClosed) return;
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.retryCount >= this.maxRetries) {
      this.onMaxRetriesExceeded?.(this.retryCount);
      return;
    }

    const delay = this.computeDelay(this.retryCount);

    this.attemptLog.push({
      attempt: this.retryCount + 1,
      delayMs: delay,
      timestamp: Date.now(),
    });

    this.onReconnectScheduled?.({ attempt: this.retryCount + 1, delayMs: delay });
    this.retryCount += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  close() {
    this.isManuallyClosed = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.terminate();
  }
}

describe('WebSocket Reconnection: Backoff Intervals & Retry Caps', () => {
  let unreachablePort;

  before(async () => {
    const dummyServer = http.createServer();
    await new Promise((resolve) => dummyServer.listen(0, '127.0.0.1', resolve));
    unreachablePort = dummyServer.address().port;
    await new Promise((resolve) => dummyServer.close(resolve));
  });

  it('scales reconnect intervals exponentially with the configured multiplier', async () => {
    const client = new ResilientWebSocketClient({
      url: `ws://127.0.0.1:${unreachablePort}/stream`,
      initialDelayMs: 25,
      multiplier: 2,
      maxDelayMs: 500,
      maxRetries: 3,
    });

    const completionPromise = new Promise((resolve) => {
      client.onMaxRetriesExceeded = () => resolve();
    });

    client.connect();
    await completionPromise;

    assert.equal(client.attemptLog.length, 3);
    assert.equal(client.attemptLog[0].delayMs, 25);
    assert.equal(client.attemptLog[1].delayMs, 50);
    assert.equal(client.attemptLog[2].delayMs, 100);

    const elapsed1 = client.attemptLog[1].timestamp - client.attemptLog[0].timestamp;
    const elapsed2 = client.attemptLog[2].timestamp - client.attemptLog[1].timestamp;

    assert.ok(elapsed1 >= 25, `expected elapsed1 >= 25ms, got ${elapsed1}ms`);
    assert.ok(elapsed2 >= 50, `expected elapsed2 >= 50ms, got ${elapsed2}ms`);

    client.close();
  });

  it('clamps delay at maxDelayMs regardless of higher retry exponents', () => {
    const client = new ResilientWebSocketClient({
      url: 'ws://localhost:9999',
      initialDelayMs: 50,
      multiplier: 3,
      maxDelayMs: 250,
      maxRetries: 5,
    });

    assert.equal(client.computeDelay(0), 50);
    assert.equal(client.computeDelay(1), 150);
    assert.equal(client.computeDelay(2), 250); // 450 clamped
    assert.equal(client.computeDelay(3), 250); // 1350 clamped
  });

  it('halts reconnection attempts once maxRetries is reached', async () => {
    const MAX_RETRIES = 2;
    const client = new ResilientWebSocketClient({
      url: `ws://127.0.0.1:${unreachablePort}/stream`,
      initialDelayMs: 15,
      multiplier: 2,
      maxRetries: MAX_RETRIES,
    });

    const completionPromise = new Promise((resolve) => {
      client.onMaxRetriesExceeded = (count) => resolve(count);
    });

    client.connect();
    const finalRetryCount = await completionPromise;

    assert.equal(finalRetryCount, MAX_RETRIES);
    assert.equal(client.attemptLog.length, MAX_RETRIES);

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(client.attemptLog.length, MAX_RETRIES, 'no further attempts after the cap');

    client.close();
  });

  it('resets retryCount and delay to baseline on a successful connection', async () => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const livePort = server.address().port;

    const client = new ResilientWebSocketClient({
      url: `ws://127.0.0.1:${livePort}/stream`,
      initialDelayMs: 20,
      multiplier: 2,
      maxRetries: 3,
    });

    await new Promise((resolve) => {
      client.onOpen = resolve;
      client.connect();
    });

    assert.equal(client.retryCount, 0);

    const serverSocket = [...wss.clients][0];
    const reconnectScheduledPromise = new Promise((resolve) => {
      client.onReconnectScheduled = (info) => resolve(info);
    });

    serverSocket.close();
    const reconnectInfo = await reconnectScheduledPromise;

    assert.equal(reconnectInfo.attempt, 1);
    assert.equal(reconnectInfo.delayMs, 20);

    client.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
});
