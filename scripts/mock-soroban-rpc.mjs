import http from 'node:http';
import {
  encodeSymbol,
  encodeAddress,
  encodeU64,
  encodeU32,
  encodeI128,
  encodeBytes,
  encodeVec,
} from '../src/indexer/scval.js';

const PORT = Number(process.env.MOCK_RPC_PORT || 8000);
const CONTRACT_ID = process.env.CONTRACT_ID || 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

// Deterministic, checksum-valid Stellar addresses (the previous revision used
// hand-written strings that fail StrKey validation and crash on startup).
const CREATOR = process.env.MOCK_CREATOR || 'GCPX5HHWGH47WOW6QIRBMHSUPB6DIZOOTSERPMZGHVIZNTPNFXSZVULF';
const CLIENT = process.env.MOCK_CLIENT || 'GABQXUYPSIKDHJGIG32ZEAVZUXDBQS2PQMHJQRTSLVMTE3GLSFAOWHCF';

const SAMPLE_HASH_HEX =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SAMPLE_HASH = Buffer.from(SAMPLE_HASH_HEX, 'hex');

let currentLedger = 1000;
let eventSequence = 1;
const eventLog = [];

function pushEvent({ contractId, topics, value }) {
  currentLedger += 1;
  const pagingToken = `${String(currentLedger).padStart(12, '0')}-${String(eventSequence++).padStart(10, '0')}`;

  const eventRecord = {
    type: 'contract',
    ledger: currentLedger,
    ledgerClosedAt: new Date().toISOString(),
    contractId,
    id: pagingToken,
    pagingToken,
    topic: topics,
    value,
    inSuccessfulContractCall: true,
  };

  eventLog.push(eventRecord);
  return eventRecord;
}

function seedInitialEvents() {
  const now = BigInt(Math.floor(Date.now() / 1000));

  // 1. IP anchor: topics (symbol, creator) | value (asset_id, BytesN<32>, timestamp)
  pushEvent({
    contractId: CONTRACT_ID,
    topics: [encodeSymbol('ip_anchor'), encodeAddress(CREATOR)],
    value: encodeVec([1n, SAMPLE_HASH, now], ['u64', undefined, 'u64']),
  });

  // 2. Escrow opened: topics (symbol, client) | value (escrow_id, creator, i128)
  pushEvent({
    contractId: CONTRACT_ID,
    topics: [encodeSymbol('escrow_new'), encodeAddress(CLIENT)],
    value: encodeVec([1n, CREATOR, 1500000000n], ['u64', 'address', 'i128']),
  });

  // 3. Milestone released: topics (symbol, escrow_id) | value (i128 payout, u32 completed)
  pushEvent({
    contractId: CONTRACT_ID,
    topics: [encodeSymbol('pay_rel'), encodeU64(1n)],
    value: encodeVec([500000000n, 1], ['i128', 'u32']),
  });
}

function handleRpc(body) {
  const { id, method, params } = body ?? {};

  switch (method) {
    case 'getHealth':
      return { jsonrpc: '2.0', id, result: { status: 'healthy', latestLedger: currentLedger } };

    case 'getLatestLedger':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          id: Buffer.from(`mock-ledger-${currentLedger}`).toString('hex'),
          protocolVersion: 22,
          sequence: currentLedger,
        },
      };

    case 'getEvents': {
      const startLedger = Number(params?.startLedger ?? 0);
      const filters = params?.filters ?? [];
      const cursor = params?.pagination?.cursor;
      const limit = params?.pagination?.limit ?? 50;

      let filtered = eventLog.filter((evt) => evt.ledger >= startLedger);

      if (cursor) {
        const idx = filtered.findIndex((e) => e.pagingToken === cursor);
        if (idx !== -1) filtered = filtered.slice(idx + 1);
      }

      if (filters.length > 0) {
        filtered = filtered.filter((evt) =>
          filters.some((f) => {
            if (f.type && f.type !== evt.type) return false;
            if (f.contractIds && !f.contractIds.includes(evt.contractId)) return false;
            return true;
          }),
        );
      }

      return {
        jsonrpc: '2.0',
        id,
        result: { latestLedger: currentLedger, events: filtered.slice(0, limit) },
      };
    }

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method '${method}' not implemented in mock replay server` },
      };
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const readBody = (onEnd) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => onEnd(body));
  };

  // REST hook to inject a fresh event mid-test.
  if (req.method === 'POST' && req.url === '/mock/emit') {
    readBody((body) => {
      try {
        const payload = JSON.parse(body || '{}');
        const now = BigInt(Math.floor(Date.now() / 1000));
        const emitted = pushEvent({
          contractId: payload.contractId || CONTRACT_ID,
          topics: payload.topics || [encodeSymbol('ip_anchor'), encodeAddress(CREATOR)],
          value:
            payload.value ||
            encodeVec([now, Buffer.alloc(32, 1), now], ['u64', undefined, 'u64']),
        });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'emitted', event: emitted }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && (req.url === '/' || req.url === '/soroban/rpc')) {
    readBody((body) => {
      try {
        const response = handleRpc(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
        );
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

// Advance the ledger so paging/cursor logic has something to page over.
const ledgerTicker = setInterval(() => {
  currentLedger += 1;
}, 5000);
if (typeof ledgerTicker.unref === 'function') ledgerTicker.unref();

seedInitialEvents();

server.listen(PORT, () => {
  console.log(`[Mock Soroban RPC] Listening on http://localhost:${PORT}/soroban/rpc`);
  console.log(`[Mock Soroban RPC] Seeded ${eventLog.length} initial Lumina Network events`);
  console.log(`[Mock Soroban RPC] Contract ID: ${CONTRACT_ID}`);
});

export { server, eventLog, pushEvent, handleRpc };
