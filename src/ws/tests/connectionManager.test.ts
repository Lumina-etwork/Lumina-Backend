/**
 * src/ws/tests/connectionManager.test.ts
 *
 * Storm test suite for Issue #3:
 * "WebSocket Connection Pool Exhaustion Under Concurrent Disconnect/Reconnect Storm"
 *
 * Tests simulate:
 *   1. Single node: rapid disconnect → reconnect within RECONNECT_GRACE_MS.
 *   2. 1,000 nodes: simultaneous 50 ms network glitch (disconnect + reconnect storm).
 *   3. Stale disconnect handler (gen check prevents spurious eviction).
 *   4. Duplicate connection rejection (still hard-blocked when outside grace window).
 *   5. Pool capacity enforcement at MAX_POOL_CAPACITY.
 *   6. Grace window expiry: node that does NOT reconnect within RECONNECT_GRACE_MS
 *      is fully evicted.
 */

import {
  ConnectionManager,
  DuplicateConnectionError,
  StaleGenerationError,
  RECONNECT_GRACE_MS,
} from '../connectionManager';
import { ConnectionPool, MAX_POOL_CAPACITY } from '../pool';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal fake socket */
function makeSocket(id?: string) {
  return {
    nodeId: id,
    close: jest.fn(),
  };
}

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ConnectionManager — Issue #3 regression suite', () => {
  let manager: ConnectionManager;

  beforeEach(() => {
    manager = new ConnectionManager();
  });

  afterEach(() => {
    manager.shutdown();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Single node happy path
  // ─────────────────────────────────────────────────────────────────────────

  it('connects a single node', () => {
    const entry = manager.handleConnect('node-1', makeSocket(), { connectionGen: 1 });
    expect(entry.nodeId).toBe('node-1');
    expect(entry.state).toBe('connected');
    expect(manager.isConnected('node-1')).toBe(true);
  });

  it('disconnects a single node (transitions to disconnecting)', () => {
    manager.handleConnect('node-1', makeSocket(), { connectionGen: 1 });
    manager.handleDisconnect('node-1', 1);
    // Pool slot is 'disconnecting' (within grace window).
    expect(manager.isConnected('node-1')).toBe(false);
    expect(manager.isDisconnecting('node-1')).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Core race condition fix: rapid reconnect within grace window
  //    (This is the exact scenario from Issue #3)
  // ─────────────────────────────────────────────────────────────────────────

  it('[Issue #3] accepts rapid reconnect within RECONNECT_GRACE_MS', async () => {
    // Step 1: Connect node with gen=1.
    manager.handleConnect('node-A', makeSocket(), { connectionGen: 1 });
    expect(manager.isConnected('node-A')).toBe(true);

    // Step 2: Network glitch — node disconnects.
    manager.handleDisconnect('node-A', 1);
    // Slot is now 'disconnecting' (SYNCHRONOUS state update).
    expect(manager.isDisconnecting('node-A')).toBe(true);

    // Step 3: Node reconnects within 50 ms (well within 500 ms grace window).
    await sleep(50);
    const reconnected = manager.handleReconnect('node-A', makeSocket(), { connectionGen: 2 });
    expect(reconnected.state).toBe('connected');
    expect(reconnected.connectionGen).toBe(2);
    expect(manager.isConnected('node-A')).toBe(true);
  });

  it('[Issue #3] reconnect is NOT rejected due to async event bus delay', async () => {
    // This test explicitly validates that no DuplicateConnectionError is thrown
    // during the window where the old code would have failed.
    manager.handleConnect('node-B', makeSocket(), { connectionGen: 1 });
    manager.handleDisconnect('node-B', 1);

    // Simulate the reconnect happening "simultaneously" (same tick).
    // In the original buggy code this would throw DuplicateConnectionError.
    expect(() => {
      manager.handleReconnect('node-B', makeSocket(), { connectionGen: 2 });
    }).not.toThrow();

    expect(manager.isConnected('node-B')).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. 1,000-node simultaneous disconnect/reconnect storm (50 ms glitch)
  // ─────────────────────────────────────────────────────────────────────────

  it('[Storm] 1,000 nodes survive a simultaneous 50 ms network glitch', async () => {
    const NODE_COUNT = 1_000;
    const GLITCH_MS = 50;

    // Connect all 1,000 nodes simultaneously.
    for (let i = 0; i < NODE_COUNT; i++) {
      manager.handleConnect(`storm-node-${i}`, makeSocket(), { connectionGen: 1 });
    }
    expect(manager.activeConnections).toBe(NODE_COUNT);

    // All 1,000 nodes disconnect simultaneously (the storm begins).
    for (let i = 0; i < NODE_COUNT; i++) {
      manager.handleDisconnect(`storm-node-${i}`, 1);
    }

    // All slots are now 'disconnecting' — none evicted yet.
    expect(manager.poolSize).toBe(NODE_COUNT);
    expect(manager.activeConnections).toBe(0); // none 'connected'

    // Simulate 50 ms network glitch — wait for nodes to "reconnect".
    await sleep(GLITCH_MS);

    // All 1,000 nodes reconnect simultaneously (within RECONNECT_GRACE_MS=500).
    const errors: Error[] = [];
    for (let i = 0; i < NODE_COUNT; i++) {
      try {
        manager.handleReconnect(`storm-node-${i}`, makeSocket(), { connectionGen: 2 });
      } catch (err) {
        errors.push(err as Error);
      }
    }

    // Zero reconnect failures allowed.
    expect(errors).toHaveLength(0);
    expect(manager.activeConnections).toBe(NODE_COUNT);
    expect(manager.poolSize).toBe(NODE_COUNT);

    // Verify all nodes are back to 'connected' with gen=2.
    for (let i = 0; i < NODE_COUNT; i++) {
      const entry = manager.getEntry(`storm-node-${i}`);
      expect(entry?.state).toBe('connected');
      expect(entry?.connectionGen).toBe(2);
    }
  }, 10_000); // 10 s timeout for 1,000-node test.

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Stale disconnect handler (generation check)
  // ─────────────────────────────────────────────────────────────────────────

  it('stale disconnect handler is ignored when gen has advanced', async () => {
    // Connect with gen=1.
    manager.handleConnect('node-C', makeSocket(), { connectionGen: 1 });

    // Node reconnects with gen=2 (race: reconnect arrives before disconnect).
    manager.handleReconnect('node-C', makeSocket(), { connectionGen: 2 });

    // Now the stale gen=1 disconnect handler fires.
    // It should be a no-op because the pool's currentGen is already 2.
    manager.handleDisconnect('node-C', 1); // gen=1 is stale
    expect(manager.isConnected('node-C')).toBe(true); // node stays connected
    expect(manager.getEntry('node-C')?.connectionGen).toBe(2);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Duplicate connection is still rejected (outside grace window)
  // ─────────────────────────────────────────────────────────────────────────

  it('rejects a duplicate connection when node is fully connected', () => {
    manager.handleConnect('node-D', makeSocket(), { connectionGen: 1 });

    // Second connection attempt without any disconnect first.
    expect(() => {
      manager.handleConnect('node-D', makeSocket(), { connectionGen: 1 });
    }).toThrow(DuplicateConnectionError);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. Grace window expiry — node that does NOT reconnect is evicted
  // ─────────────────────────────────────────────────────────────────────────

  it('evicts node after grace window when no reconnect occurs', async () => {
    manager.handleConnect('node-E', makeSocket(), { connectionGen: 1 });
    manager.handleDisconnect('node-E', 1);

    expect(manager.isDisconnecting('node-E')).toBe(true);

    // Wait past the grace window.
    await sleep(RECONNECT_GRACE_MS + 100);

    // Slot should be fully removed.
    expect(manager.isConnected('node-E')).toBe(false);
    expect(manager.isDisconnecting('node-E')).toBe(false);
    expect(manager.getEntry('node-E')).toBeUndefined();
  }, 2_000);

  // ─────────────────────────────────────────────────────────────────────────
  // 7. Pool capacity enforcement
  // ─────────────────────────────────────────────────────────────────────────

  it('enforces MAX_POOL_CAPACITY', () => {
    // Use a small pool for this test.
    const smallPool = new ConnectionPool(5);
    const m = new ConnectionManager({ pool: smallPool });

    for (let i = 0; i < 5; i++) {
      m.handleConnect(`cap-node-${i}`, makeSocket(), { connectionGen: 1 });
    }
    expect(m.poolSize).toBe(5);

    // The 6th connection should be rejected.
    const { PoolCapacityError } = require('../pool');
    expect(() => {
      m.handleConnect('cap-node-overflow', makeSocket(), { connectionGen: 1 });
    }).toThrow(PoolCapacityError);

    m.shutdown();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8. Reconnect within grace window does NOT exhaust pool (Issue #3 core)
  // ─────────────────────────────────────────────────────────────────────────

  it('[Storm] pool size stays bounded — no phantom slots after storm', async () => {
    const NODE_COUNT = 500;

    for (let i = 0; i < NODE_COUNT; i++) {
      manager.handleConnect(`bound-node-${i}`, makeSocket(), { connectionGen: 1 });
    }

    // Storm: all disconnect then reconnect rapidly.
    for (let i = 0; i < NODE_COUNT; i++) {
      manager.handleDisconnect(`bound-node-${i}`, 1);
    }
    for (let i = 0; i < NODE_COUNT; i++) {
      manager.handleReconnect(`bound-node-${i}`, makeSocket(), { connectionGen: 2 });
    }

    // Pool should contain exactly NODE_COUNT entries, not 2×NODE_COUNT.
    expect(manager.poolSize).toBe(NODE_COUNT);
    expect(manager.activeConnections).toBe(NODE_COUNT);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 9. Force eviction bypasses grace window
  // ─────────────────────────────────────────────────────────────────────────

  it('forceRemove evicts node immediately', () => {
    manager.handleConnect('node-F', makeSocket(), { connectionGen: 1 });
    manager.handleDisconnect('node-F', 1);
    expect(manager.isDisconnecting('node-F')).toBe(true);

    // Force eviction (e.g., security event).
    manager.evict('node-F');
    expect(manager.getEntry('node-F')).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 10. Multiple sequential reconnects increment generation correctly
  // ─────────────────────────────────────────────────────────────────────────

  it('multiple sequential reconnects track generation correctly', async () => {
    manager.handleConnect('node-G', makeSocket(), { connectionGen: 1 });

    for (let gen = 2; gen <= 5; gen++) {
      manager.handleDisconnect('node-G', gen - 1);
      await sleep(10); // brief delay — still within grace window
      manager.handleReconnect('node-G', makeSocket(), { connectionGen: gen });
      expect(manager.getEntry('node-G')?.connectionGen).toBe(gen);
    }

    expect(manager.isConnected('node-G')).toBe(true);
  }, 5_000);
});
