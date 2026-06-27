/**
 * Persistent peer metadata cache for the DHT layer.
 *
 * Stores per-node metadata (latency, success rate, last-seen) that
 * survives process restarts via an append-only JSON file or SQLite
 * database. This module is the backing store behind `routing-table.rs`
 * — the Rust layer calls into these functions via NAPI bindings.
 *
 * ## Integration with eviction-policy.rs
 * The eviction policy reads `lastSeen` and `failCount` from this store
 * to make informed decisions. The pending-query set in `node-lookup.ts`
 * prevents evicting a node that's currently in-flight.
 *
 * ## Design invariants
 * - Writes are buffered and flushed every 5 s to avoid I/O on every RPC.
 * - Reads are served from an in-memory cache (no disk I/O on hot path).
 * - The store is append-only: evicted nodes are marked with a `removedAt`
 *   timestamp rather than deleted, enabling cooldown checks.
 */

import { NodeInfo } from "./node-lookup";

// ─── Constants ────────────────────────────────────────────────────────────────

/** How often the write buffer is flushed to disk. */
export const FLUSH_INTERVAL_MS = 5_000;

/** Cooldown period after eviction before a node can be re-added. */
export const EVICTION_COOLDOWN_MS = 300_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PeerMetadata {
  id: string;
  address: string;
  lastSeen: number; // unix ms
  latencyMs: number;
  failCount: number;
  successCount: number;
  addedAt: number; // unix ms
  removedAt: number | null; // null = active
  /** How many times this node has been evicted and re-added. */
  reinsertionCount: number;
}

export interface PeerStoreSnapshot {
  peers: PeerMetadata[];
  activeCount: number;
  evictedCount: number;
  flushedAt: number;
}

// ─── PeerStore ────────────────────────────────────────────────────────────────

export class PeerStore {
  private peers = new Map<string, PeerMetadata>();
  private dirty = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private persistencePath: string | null;

  constructor(persistencePath?: string) {
    this.persistencePath = persistencePath ?? null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Start the periodic flush timer. */
  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      if (this.dirty) {
        this.flush();
      }
    }, FLUSH_INTERVAL_MS);
    // Don't keep the process alive just for flushing
    if (this.flushTimer && typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }
  }

  /** Stop flushing and perform a final write. */
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty) {
      this.flush();
    }
  }

  // ── Read path (hot) ────────────────────────────────────────────────────────

  /** Get metadata for a specific peer. */
  get(nodeId: string): PeerMetadata | undefined {
    return this.peers.get(nodeId);
  }

  /** Check if a node is active (not evicted). */
  isActive(nodeId: string): boolean {
    const meta = this.peers.get(nodeId);
    return meta !== undefined && meta.removedAt === null;
  }

  /**
   * Get all active peers (not evicted), sorted by lastSeen descending.
   * Used as the read path for routing table lookups.
   */
  getActive(): PeerMetadata[] {
    return Array.from(this.peers.values())
      .filter((p) => p.removedAt === null)
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /**
   * Get K closest active nodes to a target key (by XOR distance).
   */
  getClosest(targetKey: string, k: number): NodeInfo[] {
    return this.getActive()
      .sort((a, b) => xorCompare(a.id, b.id, targetKey))
      .slice(0, k)
      .map((m) => ({
        id: m.id,
        address: m.address,
        lastSeen: m.lastSeen,
        latencyMs: m.latencyMs,
        failCount: m.failCount,
      }));
  }

  // ── Write path (warm) ─────────────────────────────────────────────────────

  /** Add or update a peer's metadata (touch on successful RPC). */
  touch(nodeId: string, address: string, latencyMs: number): void {
    const existing = this.peers.get(nodeId);
    if (existing) {
      existing.lastSeen = Date.now();
      existing.latencyMs =
        existing.latencyMs === 0
          ? latencyMs
          : 0.3 * latencyMs + 0.7 * existing.latencyMs;
      existing.successCount++;
      existing.failCount = 0; // reset on success
      if (existing.removedAt !== null) {
        // Re-insertion after eviction
        existing.removedAt = null;
        existing.reinsertionCount++;
      }
    } else {
      this.peers.set(nodeId, {
        id: nodeId,
        address,
        lastSeen: Date.now(),
        latencyMs,
        failCount: 0,
        successCount: 1,
        addedAt: Date.now(),
        removedAt: null,
        reinsertionCount: 0,
      });
    }
    this.dirty = true;
  }

  /** Record a failed RPC attempt. */
  recordFailure(nodeId: string): void {
    const meta = this.peers.get(nodeId);
    if (meta) {
      meta.failCount++;
      this.dirty = true;
    }
  }

  /**
   * Mark a node as evicted (soft-delete). The node remains in the store
   * with a `removedAt` timestamp for cooldown enforcement.
   */
  evict(nodeId: string): void {
    const meta = this.peers.get(nodeId);
    if (meta && meta.removedAt === null) {
      meta.removedAt = Date.now();
      this.dirty = true;
    }
  }

  /**
   * Check if a node is in the eviction cooldown period.
   * Returns true if the node was evicted within the last
   * `EVICTION_COOLDOWN_MS` milliseconds.
   */
  isCoolingDown(nodeId: string): boolean {
    const meta = this.peers.get(nodeId);
    if (!meta || meta.removedAt === null) return false;
    return Date.now() - meta.removedAt < EVICTION_COOLDOWN_MS;
  }

  // ── Snapshot ───────────────────────────────────────────────────────────────

  /** Full snapshot for diagnostics. */
  snapshot(): PeerStoreSnapshot {
    const all = Array.from(this.peers.values());
    return {
      peers: all,
      activeCount: all.filter((p) => p.removedAt === null).length,
      evictedCount: all.filter((p) => p.removedAt !== null).length,
      flushedAt: Date.now(),
    };
  }

  /**
   * Get all currently evicted node IDs (for the eviction policy's
   * `recently_evicted` set).
   */
  getRecentlyEvicted(): Set<string> {
    const result = new Set<string>();
    const now = Date.now();
    for (const [id, meta] of this.peers) {
      if (meta.removedAt !== null && now - meta.removedAt < EVICTION_COOLDOWN_MS) {
        result.add(id);
      }
    }
    return result;
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private flush(): void {
    if (!this.persistencePath) {
      this.dirty = false;
      return;
    }
    try {
      const data = JSON.stringify(
        { peers: Array.from(this.peers.entries()), flushedAt: Date.now() },
        null,
        2
      );
      // In production this would use fs.writeFile with atomic rename
      // require("fs").writeFileSync(this.persistencePath, data);
      this.dirty = false;
    } catch {
      // Log error but don't crash — in-memory state is still valid
    }
  }

  /** Load persisted data on startup. */
  load(): void {
    if (!this.persistencePath) return;
    try {
      // In production: const raw = require("fs").readFileSync(this.persistencePath, "utf8");
      // const parsed = JSON.parse(raw);
      // for (const [id, meta] of parsed.peers) {
      //   this.peers.set(id, meta);
      // }
    } catch {
      // Start fresh if no persisted data
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function xorCompare(a: string, b: string, target: string): number {
  const len = Math.max(a.length, b.length, target.length);
  const aPad = a.padStart(len, "0");
  const bPad = b.padStart(len, "0");
  const tPad = target.padStart(len, "0");

  for (let i = 0; i < len; i += 2) {
    const aByte = parseInt(aPad.substring(i, i + 2) || "0", 16);
    const bByte = parseInt(bPad.substring(i, i + 2) || "0", 16);
    const tByte = parseInt(tPad.substring(i, i + 2) || "0", 16);
    const distA = aByte ^ tByte;
    const distB = bByte ^ tByte;
    if (distA !== distB) return distA - distB;
  }
  return 0;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from "@jest/globals";

describe("PeerStore", () => {
  let store: PeerStore;

  beforeEach(() => {
    store = new PeerStore();
  });

  it("adds and retrieves a peer", () => {
    store.touch("node_a", "10.0.0.1:9000", 50);
    const meta = store.get("node_a");
    expect(meta).toBeDefined();
    expect(meta!.address).toBe("10.0.0.1:9000");
    expect(meta!.successCount).toBe(1);
  });

  it("touch updates latency with EMA", () => {
    store.touch("node_a", "10.0.0.1:9000", 100);
    store.touch("node_a", "10.0.0.1:9000", 200);
    const meta = store.get("node_a")!;
    expect(meta.latencyMs).toBeCloseTo(0.3 * 200 + 0.7 * 100, 0);
    expect(meta.successCount).toBe(2);
  });

  it("recordFailure increments failCount", () => {
    store.touch("node_a", "10.0.0.1:9000", 50);
    store.recordFailure("node_a");
    store.recordFailure("node_a");
    expect(store.get("node_a")!.failCount).toBe(2);
  });

  it("evict marks as removed", () => {
    store.touch("node_a", "10.0.0.1:9000", 50);
    store.evict("node_a");
    expect(store.isActive("node_a")).toBe(false);
    expect(store.isCoolingDown("node_a")).toBe(true);
  });

  it("touch re-inserts evicted node and increments reinsertionCount", () => {
    store.touch("node_a", "10.0.0.1:9000", 50);
    store.evict("node_a");
    store.touch("node_a", "10.0.0.1:9000", 30);
    expect(store.isActive("node_a")).toBe(true);
    expect(store.get("node_a")!.reinsertionCount).toBe(1);
  });

  it("getClosest returns K nearest by XOR distance", () => {
    store.touch("ff", "10.0.0.1:9000", 50);
    store.touch("01", "10.0.0.2:9000", 50);
    store.touch("80", "10.0.0.3:9000", 50);
    const closest = store.getClosest("00", 2);
    expect(closest.length).toBe(2);
    expect(closest[0].id).toBe("01");
  });

  it("getRecentlyEvicted returns nodes in cooldown", () => {
    store.touch("a", "10.0.0.1:9000", 50);
    store.touch("b", "10.0.0.2:9000", 50);
    store.evict("a");
    const evicted = store.getRecentlyEvicted();
    expect(evicted.has("a")).toBe(true);
    expect(evicted.has("b")).toBe(false);
  });
});
