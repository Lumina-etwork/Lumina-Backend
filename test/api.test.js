import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeProfile, rankCandidates, scrubProse, pseudonymize } from '../src/ai/bias_sanitizer.js';
import { startServer } from '../src/index.js';
import {
  MOCK_CREATOR,
  MOCK_CONTRACT_ID,
  ipAnchorEvent,
  escrowNewEvent,
  payRelEvent,
  startMockRpc,
} from './helpers/fixtures.js';

const silent = { log() {}, warn() {}, error() {} };

describe('Bias sanitizer: demographic stripping (SDG 5)', () => {
  it('drops every demographic marker from a raw profile', () => {
    const raw = {
      address: MOCK_CREATOR,
      name: 'Ada Lovelace',
      first_name: 'Ada',
      gender: 'female',
      pronouns: 'she/her',
      age: 34,
      photo: 'https://cdn.example/ada.jpg',
      location: 'London, UK',
      country: 'GB',
      ethnicity: 'mixed',
      university: 'Cambridge',
      employer: 'ex-Google',
      merit_score: 250,
      verified_skills: ['Rust', 'Soroban', 'TypeScript'],
      completed_escrows: 4,
      total_milestones: 10,
      completed_milestones: 9,
      anchored_assets: 7,
    };

    const blind = sanitizeProfile(raw);
    const serialized = JSON.stringify(blind).toLowerCase();

    for (const forbidden of [
      'ada', 'lovelace', 'female', 'she', 'her', '34', 'london', 'cambridge',
      'google', 'photo', 'ethnic', 'gender', 'age', 'name',
    ]) {
      assert.ok(!serialized.includes(forbidden), `sanitized profile leaked "${forbidden}"`);
    }

    assert.equal(blind.merit_score, 250);
    assert.deepEqual(blind.verified_skills, ['Rust', 'Soroban', 'TypeScript']);
    assert.equal(blind.completed_escrows, 4);
    assert.equal(blind.milestone_completion_rate, 90); // 9/10
    assert.equal(blind.anchored_assets, 7);
    assert.match(blind.node_id, /^Node #\d{3}$/);
  });

  it('only ever emits the allow-listed blind schema keys', () => {
    const blind = sanitizeProfile({ address: MOCK_CREATOR, name: 'x', gender: 'y' });
    assert.deepEqual(Object.keys(blind).sort(), [
      'anchored_assets',
      'completed_escrows',
      'merit_score',
      'milestone_completion_rate',
      'node_id',
      'verified_skills',
    ]);
  });

  it('pseudonymizes deterministically and one-way', () => {
    const a = pseudonymize(MOCK_CREATOR);
    assert.equal(a, pseudonymize(MOCK_CREATOR));
    assert.notEqual(a, pseudonymize('GABQXUYPSIKDHJGIG32ZEAVZUXDBQS2PQMHJQRTSLVMTE3GLSFAOWHCF'));
    assert.ok(!a.includes(MOCK_CREATOR));
  });

  it('scrubs gendered prose without mangling real words', () => {
    const cleaned = scrubProse('She led the team, managed heritage sites and his village project');
    assert.ok(!/\b(she|his|her)\b/i.test(cleaned));
    assert.ok(cleaned.includes('managed'));
    assert.ok(cleaned.includes('heritage'));
    assert.ok(cleaned.includes('village'));
  });

  it('ranks by skill overlap and merit with no demographic input', () => {
    const pool = [
      { address: 'GCPX5HHWGH47WOW6QIRBMHSUPB6DIZOOTSERPMZGHVIZNTPNFXSZVULF', gender: 'female', name: 'A', merit_score: 200, verified_skills: ['Rust', 'Soroban'], completed_escrows: 3 },
      { address: 'GABQXUYPSIKDHJGIG32ZEAVZUXDBQS2PQMHJQRTSLVMTE3GLSFAOWHCF', gender: 'male', name: 'B', merit_score: 400, verified_skills: ['Rust', 'Soroban', 'TypeScript', 'ODRL'], completed_escrows: 8 },
    ];

    const ranked = rankCandidates(
      { required_skills: ['Rust', 'Soroban', 'TypeScript', 'ODRL'] },
      pool,
    );

    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].merit_score, 400, 'highest overlap+merit first');
    assert.ok(!('gender' in ranked[0]));
    assert.ok(!('name' in ranked[0]));
    assert.ok(ranked[0].match_score > ranked[1].match_score);
  });

  it('honours min_merit_score and min_completion_rate filters', () => {
    const pool = [
      { address: 'GCPX5HHWGH47WOW6QIRBMHSUPB6DIZOOTSERPMZGHVIZNTPNFXSZVULF', merit_score: 50, verified_skills: [], completed_escrows: 0 },
      { address: 'GABQXUYPSIKDHJGIG32ZEAVZUXDBQS2PQMHJQRTSLVMTE3GLSFAOWHCF', merit_score: 500, verified_skills: [], completed_escrows: 2 },
    ];
    const ranked = rankCandidates({ required_skills: [], min_merit_score: 100 }, pool);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].merit_score, 500);
  });
});

describe('Lumina backend API + indexer end-to-end', () => {
  let running;
  let mock;
  let base;

  before(async () => {
    mock = await startMockRpc([
      ipAnchorEvent({ assetId: 42, timestamp: 1700000000 }),
      escrowNewEvent({ escrowId: 101, totalAmount: 1000000000n, totalMilestones: 2 }),
      payRelEvent({ escrowId: 101, payout: 500000000n, completedMilestones: 1, ledger: 1002 }),
      payRelEvent({ escrowId: 101, payout: 500000000n, completedMilestones: 2, ledger: 1003 }),
    ]);

    running = await startServer({
      port: 0,
      dbPath: ':memory:',
      rpcUrl: mock.url,
      contractId: MOCK_CONTRACT_ID,
      pollIntervalMs: 30_000,
      logger: silent,
    });

    // Wait for the first poll to ingest the seeded batch.
    for (let i = 0; i < 100; i += 1) {
      const assets = running.db.prepare('SELECT COUNT(*) c FROM assets').get().c;
      const escrows = running.db.prepare('SELECT COUNT(*) c FROM escrows').get().c;
      if (assets > 0 && escrows > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    base = `http://127.0.0.1:${running.port}`;
  });

  after(async () => {
    await running?.poller.stop();
    await new Promise((resolve) => running?.wss.close(resolve));
    await new Promise((resolve) => running?.server.close(resolve));
    running?.db.close();
    await mock?.close();
  });

  it('GET /health reports healthy with the configured contract', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'healthy');
    assert.equal(body.contract_id, MOCK_CONTRACT_ID);
  });

  it('GET /api/assets exposes the indexed IP fingerprint', async () => {
    const res = await fetch(`${base}/api/assets`);
    assert.equal(res.status, 200);
    const assets = await res.json();
    assert.equal(assets.length, 1);
    assert.equal(assets[0].onchain_id, 42);
    assert.equal(assets[0].creator, MOCK_CREATOR);
    assert.equal(assets[0].fingerprint.length, 64);
  });

  it('GET /api/escrows reflects the settled escrow', async () => {
    const res = await fetch(`${base}/api/escrows`);
    const escrows = await res.json();
    assert.equal(escrows.length, 1);
    assert.equal(escrows[0].status, 'settled');
    assert.equal(escrows[0].remaining_balance, '0');
    assert.equal(escrows[0].completed_milestones, 2);
  });

  it('GET /api/creators/blind-pool leaks no demographic keys', async () => {
    // Seed a creator carrying every prohibited attribute directly in the DB.
    running.db
      .prepare(
        `INSERT OR REPLACE INTO creators (address, merit_score, verified_skills, completed_escrows)
         VALUES (?, ?, ?, ?)`,
      )
      .run(MOCK_CREATOR, 320, JSON.stringify(['Rust', 'Soroban']), 1);

    const res = await fetch(`${base}/api/creators/blind-pool`);
    assert.equal(res.status, 200);
    const pool = await res.json();
    assert.ok(pool.length >= 1);

    const prohibited = [
      'name', 'first_name', 'last_name', 'gender', 'sex', 'age',
      'photo', 'avatar', 'location', 'country', 'ethnicity',
    ];
    for (const profile of pool) {
      for (const key of prohibited) {
        assert.ok(!(key in profile), `blind pool leaked "${key}"`);
      }
      assert.match(profile.node_id, /^Node #\d{3}$/);
      assert.ok(typeof profile.merit_score === 'number');
    }
  });

  it('POST /api/match returns ranked, pseudonymized candidates', async () => {
    const res = await fetch(`${base}/api/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        required_skills: ['Rust', 'Soroban', 'Smart Contracts'],
        min_merit_score: 100,
      }),
    });

    assert.equal(res.status, 200);
    const ranked = await res.json();
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].node_id.startsWith('Node #'), true);
    assert.ok(ranked[0].matched_skills.includes('Rust'));
    assert.ok('match_score' in ranked[0]);
    assert.ok(!('name' in ranked[0]));
  });
});
