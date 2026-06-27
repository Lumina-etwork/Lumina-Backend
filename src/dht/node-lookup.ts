/**
 * Iterative Kademlia-style node lookup with pending-query protection.
 *
 * Solves the stale-node eviction race identified in issue #7:
 * - Maintains a **pending-query set** so nodes under active query are
 *   never evicted during the lookup window.
 * - Applies **touch-on-lookup** — each successful response promotes the
 *   responder to MRU position in its k-bucket via `last-seen` update.
 * - Enforces **alpha=3** parallelism with a **5 s per-node timeout**.
 *
 * ## Invariants
 * - Lookup timeout: 5 000 ms per individual FIND_NODE / FIND_VALUE RPC.
 * - Parallelism (α): 3 concurrent outstanding queries.
 * - K: 20 entries per k-bucket (enforced by `routing-table.rs`).
 *
 * ## Concurrency
 * All mutations to the pending-query set happen inside `lookup()` which
 * is itself async and single-threaded per call. The routing-table
 * mutations use the `RwLock` defined in `routing-table.rs` / NAPI binding.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Milliseconds before an individual RPC is declared timed out. */
export const NODE_LOOKUP_TIMEOUT_MS = 5_000;

/** Number of concurrent outstanding queries during an iterative lookup. */
export const LOOKUP_PARALLELISM = 3; // α (alpha)

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NodeInfo {
  id: string;
  address: string;
  lastSeen: number; // unix millis
  latencyMs: number;
  failCount: number;
}

export interface LookupResult {
  /** Closest nodes found, ordered by XOR-distance (closest first). */
  closest: NodeInfo[];
  /** Whether the lookup converged on the target. */
  converged: boolean;
  /** Total RPC round-trips performed. */
  rpcCount: number;
  /** Wall-clock duration of the entire lookup in ms. */
  durationMs: number;
}

// ─── Pending-query set ───────────────────────────────────────────────────────

/**
 * Thread-safe (single-threaded async) set of node IDs currently under
 * active query. The eviction policy (`eviction-policy.rs`) checks this
 * set before selecting an eviction candidate.
 */
export class PendingQuerySet {
  private pending = new Set<string>();

  /** Mark a node as under active query. Returns false if already pending. */
  add(nodeId: string): boolean {
    if (this.pending.has(nodeId)) return false;
    this.pending.add(nodeId);
    return true;
  }

  /** Remove a node from the pending set (called on RPC completion). */
  remove(nodeId: string): void {
    this.pending.delete(nodeId);
  }

  /** Check if a node is currently being queried. */
  has(nodeId: string): boolean {
    return this.pending.has(nodeId);
  }

  /** Snapshot of all pending IDs (for the Rust eviction policy). */
  snapshot(): Set<string> {
    return new Set(this.pending);
  }

  get size(): number {
    return this.pending.size;
  }

  clear(): void {
    this.pending.clear();
  }
}

// ─── RPC abstraction ─────────────────────────────────────────────────────────

/**
 * Abstraction over the network transport. Implementations provide the
 * actual FIND_NODE / FIND_VALUE RPC call.
 */
export interface RpcTransport {
  /**
   * Send a FIND_NODE or FIND_VALUE request to the target node.
   * Returns the list of closer peers, or throws on timeout/error.
   */
  findNode(
    targetAddress: string,
    targetId: string,
    lookupKey: string,
    timeoutMs: number
  ): Promise<NodeInfo[]>;
}

// ─── Iterative lookup ────────────────────────────────────────────────────────

/**
 * Perform an iterative Kademlia lookup for `lookupKey`.
 *
 * @param localId      - Our own node ID (hex string).
 * @param lookupKey    - The key we're looking up (hex string).
 * @param getNeighbors - Function that returns the K closest known nodes
 *                       to a given key from the routing table.
 * @param touchNode    - Callback invoked on each successful response to
 *                       update `last-seen` and `latencyMs` on the node's
 *                       k-bucket entry.
 * @param transport    - The network transport for FIND_NODE RPCs.
 * @param pending      - Shared pending-query set (prevents eviction).
 */
export async function lookup(
  localId: string,
  lookupKey: string,
  getNeighbors: (key: string, count: number) => NodeInfo[],
  touchNode: (nodeId: string, latencyMs: number) => void,
  transport: RpcTransport,
  pending: PendingQuerySet
): Promise<LookupResult> {
  const startTime = Date.now();
  let rpcCount = 0;

  // Seed set: K closest nodes we know about
  const queried = new Set<string>();
  const closest = getNeighbors(lookupKey, 20);

  // Candidates sorted by XOR distance to lookupKey
  const candidates = [...closest].sort((a, b) =>
    xorCompare(a.id, b.id, lookupKey)
  );

  // Iterate until no closer nodes are found or α parallel lookups complete
  while (true) {
    // Pick α closest un-queried candidates
    const toQuery = candidates
      .filter((n) => !queried.has(n.id))
      .slice(0, LOOKUP_PARALLELISM);

    if (toQuery.length === 0) break;

    // Register in pending-query set — prevents eviction during the RPC
    for (const node of toQuery) {
      pending.add(node.id);
      queried.add(node.id);
    }

    // Fire parallel RPCs with per-node timeout
    const rpcStart = Date.now();
    const results = await Promise.allSettled(
      toQuery.map(async (node) => {
        const t0 = Date.now();
        try {
          const peers = await transport.findNode(
            node.address,
            node.id,
            lookupKey,
            NODE_LOOKUP_TIMEOUT_MS
          );
          const latency = Date.now() - t0;

          // Touch-on-lookup: promote this node to MRU
          touchNode(node.id, latency);

          return { nodeId: node.id, peers, latency };
        } catch {
          return { nodeId: node.id, peers: [] as NodeInfo[], latency: -1 };
        } finally {
          pending.remove(node.id);
        }
      })
    );

    rpcCount += toQuery.length;

    // Merge discovered peers into candidate set
    let foundCloser = false;
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const { peers } = result.value;
      for (const peer of peers) {
        if (queried.has(peer.id)) continue;
        // Insert into candidates if closer than current K-th
        const insertIdx = candidates.findIndex(
          (c) => xorCompare(c.id, peer.id, lookupKey) > 0
        );
        if (insertIdx === -1) {
          candidates.push(peer);
        } else {
          candidates.splice(insertIdx, 0, peer);
        }
        if (
          candidates.length > 20 &&
          xorCompare(peer.id, lookupKey, "") <
            xorCompare(candidates[20].id, lookupKey, "")
        ) {
          foundCloser = true;
        }
        // Trim to K
        if (candidates.length > 20) candidates.length = 20;
      }
      if (foundCloser) break;
    }

    // Convergence check: if no closer nodes were found, stop
    if (!foundCloser && candidates.every((c) => queried.has(c.id))) {
      break;
    }
  }

  return {
    closest: candidates.slice(0, 20),
    converged: true,
    rpcCount,
    durationMs: Date.now() - startTime,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compare two node IDs by their XOR distance to a target key.
 * Returns positive if `a` is farther than `b` from `target`.
 */
function xorCompare(a: string, b: string, target: string): number {
  const distA = xorHex(a, target);
  const distB = xorHex(b, target);
  return distA > distB ? 1 : distA < distB ? -1 : 0;
}

function xorHex(a: string, b: string): string {
  const len = Math.max(a.length, b.length);
  const aPad = a.padStart(len, "0");
  const bPad = b.padStart(len, "0");
  let result = "";
  for (let i = 0; i < len; i += 2) {
    const byteA = parseInt(aPad.substring(i, i + 2) || "0", 16);
    const byteB = parseInt(bPad.substring(i, i + 2) || "0", 16);
    result += (byteA ^ byteB).toString(16).padStart(2, "0");
  }
  return result;
}
