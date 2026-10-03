import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { JitterWebSocketClient } from '../src/api/jitter-client.js';

describe('WebSocket Jitter & Thundering Herd Desynchronization', () => {
  let unreachablePort;

  before(async () => {
    const tempServer = http.createServer();
    await new Promise((resolve) => tempServer.listen(0, '127.0.0.1', resolve));
    unreachablePort = tempServer.address().port;
    await new Promise((resolve) => tempServer.close(resolve));
  });

  it('bounds Full Jitter between 0 and the exponential ceiling', () => {
    const client = new JitterWebSocketClient({
      url: 'ws://127.0.0.1:9999',
      baseDelayMs: 40,
      multiplier: 2,
      maxDelayMs: 320,
      strategy: 'full',
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const ceiling = Math.min(320, 40 * Math.pow(2, attempt));
      for (let i = 0; i < 50; i += 1) {
        const delay = client.computeDelay(attempt, 40);
        assert.ok(
          delay >= 0 && delay <= ceiling,
          `delay ${delay} exceeded ceiling ${ceiling} on attempt ${attempt}`,
        );
      }
    }
  });

  it('desynchronizes 100 concurrent clients disconnecting at the same instant', () => {
    const CLIENT_COUNT = 100;
    const baseDelay = 50;
    const disconnectEpoch = 1000;

    const scheduledTimes = [];
    for (let i = 0; i < CLIENT_COUNT; i += 1) {
      const client = new JitterWebSocketClient({
        url: `ws://127.0.0.1:${unreachablePort}/stream`,
        baseDelayMs: baseDelay,
        multiplier: 2,
        maxDelay: 800,
        maxDelayMs: 800,
        strategy: 'full',
      });
      // Attempt 1 ceiling = min(800, 50 * 2^1) = 100ms
      scheduledTimes.push(disconnectEpoch + client.computeDelay(1, baseDelay));
    }

    const uniqueTimestamps = new Set(scheduledTimes);
    const spread = Math.max(...scheduledTimes) - Math.min(...scheduledTimes);

    assert.ok(spread >= 60, `expected spread >= 60ms, received ${spread}ms`);
    assert.ok(
      uniqueTimestamps.size > 50,
      `expected > 50 distinct reconnect timestamps, received ${uniqueTimestamps.size}`,
    );

    // No single 5ms bucket may absorb more than 25% of the reconnect traffic.
    const BUCKET_SIZE_MS = 5;
    const minTimestamp = Math.min(...scheduledTimes);
    const buckets = {};
    for (const time of scheduledTimes) {
      const bucket = Math.floor((time - minTimestamp) / BUCKET_SIZE_MS);
      buckets[bucket] = (buckets[bucket] || 0) + 1;
    }

    const peak = Math.max(...Object.values(buckets));
    assert.ok(
      peak < CLIENT_COUNT * 0.25,
      `thundering herd: ${peak} clients clustered in one ${BUCKET_SIZE_MS}ms bucket`,
    );
  });

  it('keeps Decorrelated Jitter within [base, maxDelay]', () => {
    const base = 50;
    const max = 1000;
    const client = new JitterWebSocketClient({
      url: 'ws://127.0.0.1:9999',
      baseDelayMs: base,
      maxDelayMs: max,
      strategy: 'decorrelated',
    });

    let prevDelay = base;
    for (let i = 0; i < 20; i += 1) {
      const nextDelay = client.computeDelay(i, prevDelay);
      assert.ok(nextDelay >= base, `decorrelated delay ${nextDelay} dropped below base ${base}`);
      assert.ok(nextDelay <= max, `decorrelated delay ${nextDelay} exceeded cap ${max}`);
      prevDelay = nextDelay;
    }
  });

  it('re-establishes a live connection following a jittered delay', async () => {
    const liveServer = http.createServer();
    const wss = new WebSocketServer({ server: liveServer });
    await new Promise((resolve) => liveServer.listen(0, '127.0.0.1', resolve));
    const livePort = liveServer.address().port;

    const client = new JitterWebSocketClient({
      url: `ws://127.0.0.1:${livePort}/stream`,
      baseDelayMs: 20,
      multiplier: 2,
      maxDelayMs: 100,
      maxRetries: 3,
      strategy: 'full',
    });

    const openPromise = new Promise((resolve) => {
      client.onOpen = resolve;
    });

    client.connect();
    await openPromise;

    assert.equal(client.retryCount, 0);
    assert.equal(client.ws.readyState, 1); // OPEN

    client.close();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => liveServer.close(resolve));
  });
});
