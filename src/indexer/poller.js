import { rpc } from '@stellar/stellar-sdk';
import { statements } from '../db/schema.js';
import {
  EVENT_IP_ANCHOR,
  EVENT_ESCROW_NEW,
  EVENT_PAY_REL,
  decodeTopics,
  decodeEventData,
  eventName,
  isValidAddress,
} from './scval.js';

const CURSOR_KEY = 'latest_paging_token';
const START_LEDGER_KEY = 'start_ledger';

/**
 * Polls Soroban RPC for Lumina contract events, decodes the ScVal payloads and
 * persists them to SQLite inside a single transaction per batch.
 *
 * Resumption uses the paging token when the endpoint supplies one and falls
 * back to the ledger sequence, so a restart neither replays nor skips events.
 */
export class IndexerPoller {
  constructor({
    db,
    server,
    contractId,
    pollIntervalMs = 2000,
    startLedger = 0,
    broadcast = () => {},
    logger = console,
  }) {
    this.db = db;
    this.server = server;
    this.contractId = contractId;
    this.pollIntervalMs = pollIntervalMs;
    this.startLedger = startLedger;
    this.broadcast = broadcast;
    this.logger = logger;
    this.stmt = statements(db);
    this.timer = null;
    this.running = false;
    this.stopped = false;
  }

  readCursor() {
    const cursor = this.stmt.getCursor.get(CURSOR_KEY);
    if (cursor?.value) return cursor.value;

    const start = this.stmt.getCursor.get(START_LEDGER_KEY);
    const parsed = Number(start?.value);
    return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : String(this.startLedger ?? 0);
  }

  writeCursor(value) {
    this.stmt.setCursor.run(CURSOR_KEY, String(value));
  }

  /** Persist one batch atomically so a crash cannot leave a half-applied ledger. */
  ingestBatch(events) {
    const applied = this.db.transaction((batch) => {
      const results = [];
      for (const event of batch) {
        try {
          results.push(this.ingestEvent(event));
        } catch (error) {
          this.logger.error?.(`[indexer] failed to ingest ${event?.pagingToken}: ${error.message}`);
        }
      }
      if (batch.length > 0) {
        const last = batch[batch.length - 1];
        this.writeCursor(last.pagingToken ?? last.id ?? this.readCursor());
      }
      return results.filter(Boolean);
    });

    return applied(events);
  }

  ingestEvent(event) {
    const name = eventName(event.topic);
    const topics = decodeTopics(event.topic);
    const data = decodeEventData(event.value);

    switch (name) {
      case EVENT_IP_ANCHOR:
        return this.ingestIpAnchor(topics, data, event);
      case EVENT_ESCROW_NEW:
        return this.ingestEscrowNew(topics, data, event);
      case EVENT_PAY_REL:
        return this.ingestPayout(topics, data, event);
      default:
        return null;
    }
  }

  ingestIpAnchor(topics, data, event) {
    const creator = topics[1];
    const [assetId, fingerprint, timestamp] = data;

    if (!isValidAddress(creator)) {
      this.logger.warn?.(`[indexer] ip_anchor with invalid creator address: ${creator}`);
      return null;
    }
    if (!Buffer.isBuffer(fingerprint)) {
      this.logger.warn?.(`[indexer] ip_anchor ${assetId} missing BytesN<32> fingerprint`);
      return null;
    }

    const fingerprintHex = fingerprint.toString('hex');
    const info = this.stmt.insertAsset.run({
      onchain_id: Number(assetId),
      creator,
      fingerprint: fingerprintHex,
      metadata_uri: null,
      licensing_fee: null,
      timestamp: Number(timestamp),
    });

    this.stmt.upsertCreator.run({ address: creator, merit_score: 100, verified_skills: '[]' });

    if (info.changes === 0) return null; // duplicate, already indexed

    const payload = {
      type: 'IP_ANCHOR',
      data: {
        asset_id: Number(assetId),
        creator,
        fingerprint: fingerprintHex,
        timestamp: Number(timestamp),
      },
    };
    this.broadcast(payload);
    this.logger.log?.(`[indexer] anchored asset ${assetId} by ${creator}`);
    return payload;
  }

  ingestEscrowNew(topics, data, event) {
    const client = topics[1];
    const [escrowId, creator, totalAmount, totalMilestones] = data;

    if (!isValidAddress(client) || !isValidAddress(creator)) {
      this.logger.warn?.(`[indexer] escrow_new ${escrowId} has invalid addresses`);
      return null;
    }

    const amount = BigInt(totalAmount).toString();
    const info = this.stmt.insertEscrow.run({
      onchain_id: Number(escrowId),
      client,
      creator,
      total_amount: amount,
      remaining_balance: amount,
      total_milestones: Number(totalMilestones),
    });

    this.stmt.upsertCreator.run({ address: creator, merit_score: 100, verified_skills: '[]' });

    if (info.changes === 0) return null;

    const payload = {
      type: 'ESCROW_CREATED',
      data: {
        escrow_id: Number(escrowId),
        client,
        creator,
        total_amount: amount,
        total_milestones: Number(totalMilestones),
      },
    };
    this.broadcast(payload);
    return payload;
  }

  ingestPayout(topics, data, event) {
    const escrowId = Number(topics[1]);
    const [payoutAmount, completedMilestones] = data;

    const record = this.stmt.getEscrow.get(escrowId);
    if (!record) {
      this.logger.warn?.(`[indexer] pay_rel for unknown escrow ${escrowId}`);
      return null;
    }

    const remaining = (BigInt(record.remaining_balance) - BigInt(payoutAmount)).toString();
    const completed = Number(completedMilestones);
    const status = completed >= Number(record.total_milestones) ? 'settled' : 'active';

    this.stmt.applyPayout.run({
      onchain_id: escrowId,
      remaining_balance: remaining,
      completed_milestones: completed,
      status,
    });

    if (status === 'settled') {
      this.stmt.incrementCreatorEscrows.run(record.creator);
    }

    const payload = {
      type: 'MILESTONE_RELEASED',
      data: {
        escrow_id: escrowId,
        payout_amount: BigInt(payoutAmount).toString(),
        completed_milestones: completed,
        status,
      },
    };
    this.broadcast(payload);
    this.logger.log?.(`[indexer] released milestone ${completed} on escrow ${escrowId}`);
    return payload;
  }

  async pollOnce() {
    const cursor = this.readCursor();
    // A persisted cursor is a `<ledger>-<sequence>` paging token, which the RPC
    // only accepts via `pagination.cursor`. Passing it as `startLedger` yields a
    // NaN ledger and silently stops ingesting, so keep the two paths distinct.
    const usingToken = /^\d+-\d+$/.test(cursor);

    const { events = [] } = await this.server.getEvents({
      ...(usingToken ? {} : { startLedger: Number(cursor) || 0 }),
      filters: [{ type: 'contract', contractIds: [this.contractId] }],
      pagination: { limit: 100, ...(usingToken ? { cursor } : {}) },
    });

    return events.length === 0 ? [] : this.ingestBatch(events);
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.stopped = false;

    const loop = async () => {
      while (!this.stopped) {
        try {
          await this.pollOnce();
        } catch (error) {
          this.logger.error?.(`[indexer] poll failed: ${error.message}`);
        }
        if (this.stopped) break;
        await new Promise((resolve) => {
          this.timerResolve = resolve;
          this.timer = setTimeout(resolve, this.pollIntervalMs);
        });
        this.timerResolve = null;
      }
    };

    // Do not block startup on the first poll.
    this.loopPromise = loop();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    // Wake the inter-poll sleep rather than leaving it pending forever, which
    // would make this method's await on loopPromise deadlock.
    if (this.timerResolve) {
      this.timerResolve();
      this.timerResolve = null;
    }
    if (this.loopPromise) await this.loopPromise.catch(() => {});
    this.running = false;
  }
}

export function createPoller({ db, rpcUrl, contractId, pollIntervalMs, startLedger, broadcast, logger }) {
  return new IndexerPoller({
    db,
    server: new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') }),
    contractId,
    pollIntervalMs,
    startLedger,
    broadcast,
    logger,
  });
}
