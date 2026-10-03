import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IdempotencyEngine } from '../src/api/idempotency-engine.js';

const silent = { error() {} };

/** Minimal stand-in for a ws socket that records outbound frames. */
const makeWs = () => {
  const frames = [];
  return { frames, send: (raw) => frames.push(JSON.parse(raw.toString())) };
};

const frame = (msgId, data = {}) => JSON.stringify({ msg_id: msgId, data });

describe('IdempotencyEngine: at-least-once consumer dedupe', () => {
  it('runs the handler once and ACKs duplicates without reprocessing', async () => {
    const engine = new IdempotencyEngine({ ttlMs: 60_000, pruneIntervalMs: 1e9, logger: silent });
    const ws = makeWs();
    let calls = 0;

    const raw = frame('msg-1', { amount: 10 });
    const first = await engine.processIncoming(ws, raw, async () => {
      calls += 1;
    });
    const second = await engine.processIncoming(ws, raw, async () => {
      calls += 1;
    });

    assert.equal(first.status, 'processed');
    assert.equal(second.status, 'duplicate');
    assert.equal(calls, 1, 'handler must run exactly once per msg_id');
    assert.deepEqual(ws.frames, [
      { type: 'ACK', msg_id: 'msg-1' },
      { type: 'ACK', msg_id: 'msg-1' },
    ]);

    engine.close();
  });

  it('does not cache a handler failure: the frame stays retryable', async () => {
    const engine = new IdempotencyEngine({ ttlMs: 60_000, pruneIntervalMs: 1e9, logger: silent });
    const ws = makeWs();
    let attempts = 0;

    const handler = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient upstream failure');
    };

    const raw = frame('msg-fail');
    const failed = await engine.processIncoming(ws, raw, handler);

    assert.equal(failed.status, 'error');
    assert.equal(engine.has('msg-fail'), false, 'failed msg_id must be released');
    assert.equal(ws.frames.length, 0, 'a failure must not be ACKed');

    const retried = await engine.processIncoming(ws, raw, handler);

    assert.equal(retried.status, 'processed');
    assert.equal(attempts, 2, 'the retry must reach the handler again');
    assert.deepEqual(ws.frames, [{ type: 'ACK', msg_id: 'msg-fail' }]);

    engine.close();
  });

  it('prunes only entries older than the TTL', () => {
    const engine = new IdempotencyEngine({ ttlMs: 500, pruneIntervalMs: 1e9, logger: silent });
    const now = Date.now();

    engine.record('expired', 'PROCESSED', now - 1000);
    engine.record('fresh', 'PROCESSED', now);

    assert.equal(engine.pruneExpired(now), 1);
    assert.equal(engine.has('expired'), false);
    assert.equal(engine.has('fresh'), true);

    engine.close();
  });

  it('single-flights concurrent copies of the same frame', async () => {
    const engine = new IdempotencyEngine({ ttlMs: 60_000, pruneIntervalMs: 1e9, logger: silent });
    const ws = makeWs();
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    const handler = async () => {
      calls += 1;
      await gate;
    };

    const raw = frame('msg-concurrent');
    const first = engine.processIncoming(ws, raw, handler);
    const second = engine.processIncoming(ws, raw, handler);

    release();
    const results = await Promise.all([first, second]);

    assert.equal(calls, 1, 'concurrent duplicates must not both run the handler');
    assert.deepEqual(
      results.map((r) => r.status).sort(),
      ['duplicate', 'processed'],
    );

    engine.close();
  });

  it('ignores malformed frames and frames without a msg_id', async () => {
    const engine = new IdempotencyEngine({ ttlMs: 60_000, pruneIntervalMs: 1e9, logger: silent });
    const ws = makeWs();

    assert.equal((await engine.processIncoming(ws, 'not json', async () => {})).status, 'invalid');
    assert.equal((await engine.processIncoming(ws, frame(''), async () => {})).status, 'invalid');
    assert.equal(ws.frames.length, 0);

    engine.close();
  });
});
