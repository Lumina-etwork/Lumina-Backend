import {
  encodeSymbol,
  encodeAddress,
  encodeU64,
  encodeU32,
  encodeI128,
  encodeBytes,
  encodeVec,
} from '../../src/indexer/scval.js';

/**
 * Checksum-valid Stellar addresses derived from fixed seeds, so assertions are
 * stable across runs. The hand-written addresses in the original drafts failed
 * StrKey validation ("Unsupported address type") and threw during setup.
 */
export const MOCK_CREATOR = 'GCPX5HHWGH47WOW6QIRBMHSUPB6DIZOOTSERPMZGHVIZNTPNFXSZVULF';
export const MOCK_CLIENT = 'GABQXUYPSIKDHJGIG32ZEAVZUXDBQS2PQMHJQRTSLVMTE3GLSFAOWHCF';

export const MOCK_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

export const SAMPLE_HASH_HEX =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const SAMPLE_HASH = Buffer.from(SAMPLE_HASH_HEX, 'hex');

export function contractEvent({
  contractId = MOCK_CONTRACT_ID,
  ledger = 1000,
  sequence = 1,
  topics,
  value,
}) {
  const pagingToken = `${String(ledger).padStart(12, '0')}-${String(sequence).padStart(10, '0')}`;
  return {
    type: 'contract',
    ledger,
    ledgerClosedAt: new Date().toISOString(),
    contractId,
    id: pagingToken,
    pagingToken,
    topic: topics,
    value,
    inSuccessfulContractCall: true,
  };
}

export const ipAnchorEvent = ({ assetId = 42, hash = SAMPLE_HASH, timestamp = 1700000000, ledger = 1000 } = {}) =>
  contractEvent({
    ledger,
    topics: [encodeSymbol('ip_anchor'), encodeAddress(MOCK_CREATOR)],
    value: encodeVec([BigInt(assetId), hash, BigInt(timestamp)], ['u64', undefined, 'u64']),
  });

export const escrowNewEvent = ({
  escrowId = 101,
  creator = MOCK_CREATOR,
  client = MOCK_CLIENT,
  totalAmount = 1000000000n,
  totalMilestones = 2,
  ledger = 1001,
} = {}) =>
  contractEvent({
    ledger,
    topics: [encodeSymbol('escrow_new'), encodeAddress(client)],
    value: encodeVec(
      [BigInt(escrowId), creator, totalAmount, totalMilestones],
      ['u64', 'address', 'i128', 'u32'],
    ),
  });

export const payRelEvent = ({
  escrowId = 101,
  payout = 500000000n,
  completedMilestones = 1,
  ledger = 1002,
} = {}) =>
  contractEvent({
    ledger,
    topics: [encodeSymbol('pay_rel'), encodeU64(escrowId)],
    value: encodeVec([payout, completedMilestones], ['i128', 'u32']),
  });

/** Minimal in-process JSON-RPC server replaying a fixed event list. */
export async function startMockRpc(events) {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const { id, method } = JSON.parse(body || '{}');
      if (method === 'getHealth') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { status: 'healthy' } }));
        return;
      }
      if (method === 'getEvents') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { latestLedger: 9999, events } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'nope' } }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/soroban/rpc`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export { encodeSymbol, encodeAddress, encodeU64, encodeU32, encodeI128, encodeBytes, encodeVec };
