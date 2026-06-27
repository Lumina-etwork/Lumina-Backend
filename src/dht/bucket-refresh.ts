/**
 * Periodic bucket refresh for the DHT routing table.
 *
 * Addresses issue #7 requirements:
 * - **Bucket refresh interval:** 3600 s — each bucket is refreshed at
 *   least once per hour by performing a random-ID lookup in that bucket's
 *   prefix range.
 * - **Bucket-level last-refresh watermark:** prevents a bucket from being
 *   refreshed too aggressively; only stale buckets (watermark older than
 *   the refresh interval) trigger a lookup.
 * - **Batch-coalesced evictions:** at most 5 evictions per batch window
 *   (10 s) per bucket, matching `eviction-policy.rs`.
 *
 * ## Design
 * The refresh loop runs as a background interval. On each tick it:
 * 1. Iterates over the 160 k-buckets (in random order to avoid thundering
 *    herd on startup).
 * 2. Skips any bucket whose `lastRefreshAt` is within the refresh window.
 * 3. Generates a random node ID in the bucket's prefix range and performs
 *    a `lookup()` via `node-lookup.ts`.
 * 4. The lookup naturally promotes responsive nodes and the eviction
 *    policy handles stale ones.
 */

import { PendingQuerySet } from "./node-lookup";

// ─── Constants ────────────────────────────────────────────────────────────────

/** How often each bucket is refreshed (seconds). */
export const BUCKET_REFRESH_INTERVAL_MS = 3_600_000;

/** Maximum evictions per batch window per bucket. */
export const MAX_EVICTIONS_PER_BATCH = 5;

/** Duration of a batch eviction window. */
export const BATCH_WINDOW_MS = 10_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BucketRefreshState {
  /** Index of the bucket (0–159). */
  bucketIndex: number;
  /** Epoch-ms timestamp of the last refresh attempt. */
  lastRefreshAt: number;
  /** Number of evictions performed in the current batch window. */
  evictionsThisWindow: number;
  /** When the current batch window started. */
  windowStart: number;
}

export interface RefreshDeps {
  /** Return the total number of k-buckets. */
  numBuckets(): number;
  /** Perform a node lookup for a synthetic ID in the given prefix. */
  lookup(key: string): Promise<void>;
  /** Generate a random hex ID in the given bucket prefix. */
  randomIdForBucket(bucketIndex: number): string;
  /** Current epoch-ms timestamp. */
  now(): number;
}

// ─── Refresh coordinator ──────────────────────────────────────────────────────

/**
 * Creates a bucket-refresh coordinator that can be started/stopped as a
 * background loop.
 */
export function createBucketRefresh(deps: RefreshDeps) {
  const states: BucketRefreshState[] = [];
  const numBuckets = deps.numBuckets();

  for (let i = 0; i < numBuckets; i++) {
    states.push({
      bucketIndex: i,
      lastRefreshAt: 0,
      evictionsThisWindow: 0,
      windowStart: deps.now(),
    });
  }

  /**
   * Run a single refresh pass over all stale buckets.
   * Called once per tick of the refresh interval.
   */
  async function refreshPass(): Promise<number> {
    const now = deps.now();
    let refreshed = 0;

    // Shuffle bucket order to avoid thundering herd on startup
    const order = shuffledIndices(numBuckets);

    for (const idx of order) {
      const state = states[idx];

      // Skip if refreshed recently
      if (now - state.lastRefreshAt < BUCKET_REFRESH_INTERVAL_MS) {
        continue;
      }

      // Reset batch window if expired
      if (now - state.windowStart >= BATCH_WINDOW_MS) {
        state.evictionsThisWindow = 0;
        state.windowStart = now;
      }

      state.lastRefreshAt = now;
      refreshed++;

      // Generate a random ID in this bucket's prefix range and look it up
      const randomId = deps.randomIdForBucket(state.bucketIndex);
      await deps.lookup(randomId);
    }

    return refreshed;
  }

  /**
   * Check if a bucket can still evict within its current batch window.
   */
  function canEvict(bucketIndex: number): boolean {
    const state = states[bucketIndex];
    const now = deps.now();

    if (now - state.windowStart >= BATCH_WINDOW_MS) {
      state.evictionsThisWindow = 0;
      state.windowStart = now;
      return true;
    }

    return state.evictionsThisWindow < MAX_EVICTIONS_PER_BATCH;
  }

  /**
   * Record that an eviction occurred in the given bucket.
   */
  function recordEviction(bucketIndex: number): void {
    const state = states[bucketIndex];
    state.evictionsThisWindow++;
  }

  /**
   * Get the refresh watermark for a given bucket.
   */
  function getLastRefreshAt(bucketIndex: number): number {
    return states[bucketIndex]?.lastRefreshAt ?? 0;
  }

  return {
    refreshPass,
    canEvict,
    recordEviction,
    getLastRefreshAt,
    states,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fisher-Yates shuffle of indices `[0, n)`.
 */
function shuffledIndices(n: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

import { describe, it, expect, jest } from "@jest/globals";

describe("createBucketRefresh", () => {
  function fakeDeps(numBuckets = 160) {
    let currentTime = 1000;
    const lookupCalls: string[] = [];

    return {
      deps: {
        numBuckets: () => numBuckets,
        lookup: async (key: string) => {
          lookupCalls.push(key);
        },
        randomIdForBucket: (idx: number) => `random_${idx}`,
        now: () => currentTime,
      },
      lookupCalls,
      advanceTime: (ms: number) => {
        currentTime += ms;
      },
    };
  }

  it("refreshes all stale buckets on first pass", async () => {
    const { deps, lookupCalls } = fakeDeps(10);
    const refresh = createBucketRefresh(deps);

    const count = await refresh.refreshPass();
    expect(count).toBe(10);
    expect(lookupCalls).toHaveLength(10);
  });

  it("skips recently refreshed buckets", async () => {
    const { deps, lookupCalls, advanceTime } = fakeDeps(10);
    const refresh = createBucketRefresh(deps);

    await refresh.refreshPass();
    lookupCalls.length = 0;

    // Call again immediately — nothing should refresh
    const count = await refresh.refreshPass();
    expect(count).toBe(0);
    expect(lookupCalls).toHaveLength(0);
  });

  it("refreshes again after the interval elapses", async () => {
    const { deps, lookupCalls, advanceTime } = fakeDeps(5);
    const refresh = createBucketRefresh(deps);

    await refresh.refreshPass();
    lookupCalls.length = 0;

    advanceTime(BUCKET_REFRESH_INTERVAL_MS + 1);
    const count = await refresh.refreshPass();
    expect(count).toBe(5);
  });

  it("enforces batch eviction limit", () => {
    const { deps } = fakeDeps(1);
    const refresh = createBucketRefresh(deps);

    for (let i = 0; i < 5; i++) {
      expect(refresh.canEvict(0)).toBe(true);
      refresh.recordEviction(0);
    }
    expect(refresh.canEvict(0)).toBe(false);
  });

  it("resets batch window after timeout", () => {
    const { deps, advanceTime } = fakeDeps(1);
    const refresh = createBucketRefresh(deps);

    for (let i = 0; i < 5; i++) {
      refresh.recordEviction(0);
    }
    expect(refresh.canEvict(0)).toBe(false);

    advanceTime(BATCH_WINDOW_MS + 1);
    expect(refresh.canEvict(0)).toBe(true);
  });
});
