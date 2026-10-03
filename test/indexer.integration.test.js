import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rpc } from '@stellar/stellar-sdk';

import { initDatabase } from '../src/db/schema.js';
import { IndexerPoller } from '../src/indexer/poller.js';
import { decodeTopics, decodeEventData } from '../src/indexer/scval.js';
import {
  MOCK_CONTRACT_ID,
  MOCK_CREATOR,
  MOCK_CLIENT,
  SAMPLE_HASH_HEX,
  ipAnchorEvent,
  escrowNewEvent,
  payRelEvent,
  startMockRpc,
} from './helpers/fixtures.js';

const silent = { log() {}, warn() {}, error() {} };

describe('Lumina Event Indexer: decoding + SQLite ingestion', () => {
  let db;
  let mock;
  let poller;

  before(async () => {
    db = initDatabase(':memory:');
    mock = await startMockRpc([
      ipAnchorEvent({ assetId: 42, timestamp: 1700000000 }),
      escrowNewEvent({ escrowId: 101, totalAmount: 1000000000n, totalMilestones: 2 }),
      payRelEvent({ escrowId: 101, payout: 500000000n, completedMilestones: 1, ledger: 1002 }),
      payRelEvent({ escrowId: 101, payout: 500000000n, completedMilestones: 2, ledger: 1003 }),
    ]);
  });

  after(async () => {
    await poller?.stop();
    await mock?.close();
    db?.close();
  });

  it('decodes an ip_anchor event: symbol topic, creator address, BytesN<32> fingerprint', async () => {
    const server = new rpc.Server(mock.url, { allowHttp: true });
    const { events } = await server.getEvents({
      startLedger: 0,
      filters: [{ type: 'contract', contractIds: [MOCK_CONTRACT_ID] }],
    });

    const anchor = events[0];
    const topics = decodeTopics(anchor.topic);

    assert.equal(topics[0], 'ip_anchor');
    assert.equal(topics[1], MOCK_CREATOR);

    const [assetId, fingerprint, timestamp] = decodeEventData(anchor.value);
    assert.equal(Number(assetId), 42);
    assert.ok(Buffer.isBuffer(fingerprint), 'fingerprint must decode to raw bytes');
    assert.equal(fingerprint.toString('hex'), SAMPLE_HASH_HEX);
    assert.equal(Number(timestamp), 1700000000);
  });

  it('ingests the asset, escrow and both payouts in one transactional batch', async () => {
    const server = new rpc.Server(mock.url, { allowHttp: true });
    const { events } = await server.getEvents({
      startLedger: 0,
      filters: [{ type: 'contract', contractIds: [MOCK_CONTRACT_ID] }],
    });

    const broadcast = [];
    poller = new IndexerPoller({
      db,
      server,
      contractId: MOCK_CONTRACT_ID,
      pollIntervalMs: 10_000,
      broadcast: (p) => broadcast.push(p),
      logger: silent,
    });

    const applied = poller.ingestBatch(events);
    assert.equal(applied.length, 4, 'all four events should apply');

    const asset = db.prepare('SELECT * FROM assets WHERE onchain_id = ?').get(42);
    assert.ok(asset);
    assert.equal(asset.creator, MOCK_CREATOR);
    assert.equal(asset.fingerprint, SAMPLE_HASH_HEX);
    assert.equal(asset.timestamp, 1700000000);
  });

  it('settles the escrow after the final milestone and credits the creator', () => {
    const escrow = db.prepare('SELECT * FROM escrows WHERE onchain_id = ?').get(101);
    assert.ok(escrow);
    assert.equal(escrow.client, MOCK_CLIENT);
    assert.equal(escrow.creator, MOCK_CREATOR);
    assert.equal(escrow.total_amount, '1000000000');
    assert.equal(escrow.remaining_balance, '0');
    assert.equal(escrow.completed_milestones, 2);
    assert.equal(escrow.total_milestones, 2);
    assert.equal(escrow.status, 'settled');

    const creator = db.prepare('SELECT * FROM creators WHERE address = ?').get(MOCK_CREATOR);
    assert.ok(creator, 'creator row is created on first sighting');
    assert.equal(creator.completed_escrows, 1);
  });

  it('is idempotent: re-ingesting the same batch changes nothing', () => {
    const before = {
      assets: db.prepare('SELECT COUNT(*) c FROM assets').get().c,
      escrows: db.prepare('SELECT COUNT(*) c FROM escrows').get().c,
    };

    // Replay the identical batch.
    const applied = poller.ingestBatch([
      ipAnchorEvent({ assetId: 42, timestamp: 1700000000 }),
      escrowNewEvent({ escrowId: 101 }),
    ]);

    assert.equal(applied.length, 0, 'duplicates are rejected');

    const after = {
      assets: db.prepare('SELECT COUNT(*) c FROM assets').get().c,
      escrows: db.prepare('SELECT COUNT(*) c FROM escrows').get().c,
    };
    assert.deepEqual(after, before);
  });

  it('persists the paging token cursor for resumable polling', () => {
    const cursor = db.prepare('SELECT value FROM sync_cursor WHERE key = ?').get('latest_paging_token');
    assert.ok(cursor?.value, 'cursor must be written');
    assert.match(cursor.value, /^\d+-\d+$/);
  });

  it('resumes via pagination.cursor (not startLedger) once a token is stored', async () => {
    const cursorDb = initDatabase(':memory:');
    try {
      cursorDb
        .prepare('INSERT OR REPLACE INTO sync_cursor (key, value) VALUES (?, ?)')
        .run('latest_paging_token', '000000001003-0000000003');

      let captured;
      const fakeServer = {
        getEvents: async (request) => {
          captured = request;
          return { events: [] };
        },
      };

      const p = new IndexerPoller({
        db: cursorDb,
        server: fakeServer,
        contractId: MOCK_CONTRACT_ID,
        pollIntervalMs: 1000,
        logger: silent,
      });
      await p.pollOnce();

      assert.equal(captured.pagination.cursor, '000000001003-0000000003');
      assert.equal(captured.startLedger, undefined, 'a token must not be sent as startLedger');
    } finally {
      cursorDb.close();
    }
  });

  it('uses a numeric startLedger before any token has been persisted', async () => {
    const freshDb = initDatabase(':memory:');
    try {
      let captured;
      const fakeServer = {
        getEvents: async (request) => {
          captured = request;
          return { events: [] };
        },
      };

      const p = new IndexerPoller({
        db: freshDb,
        server: fakeServer,
        contractId: MOCK_CONTRACT_ID,
        pollIntervalMs: 1000,
        startLedger: 7,
        logger: silent,
      });
      await p.pollOnce();

      assert.equal(captured.startLedger, 7);
      assert.equal(captured.pagination.cursor, undefined);
    } finally {
      freshDb.close();
    }
  });

  it('ignores pay_rel for an escrow it has never seen', () => {
    const orphan = payRelEvent({ escrowId: 999, completedMilestones: 1, ledger: 1010 });
    const applied = poller.ingestBatch([orphan]);
    assert.equal(applied.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM escrows WHERE onchain_id = 999').get().c, 0);
  });
});
