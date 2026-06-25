import * as net from 'net';
import { EventEmitter } from 'events';

/**
 * Zombie detector — periodic scanner for orphaned flow-table entries.
 *
 * After a graceful shutdown sequence, some flow entries may remain in the
 * table even though the proxy-side socket has been destroyed.  These are
 * "zombies": ghost entries whose TCP state is half-open (client and upstream
 * think the connection is alive, but the proxy has dropped its reference).
 *
 * The detector runs on a configurable interval (default 60s, matching the
 * flow-table stale TTL) and:
 *
 *  1. Reads all flow entries whose `proxy_socket_alive === false`.
 *  2. For each, sends a TCP keepalive probe to the upstream address.
 *  3. If the upstream does not respond within `probe_timeout_ms`, the entry
 *     is evicted from the flow table immediately.
 *  4. If the upstream responds (RST or ACK), the entry is also evicted —
 *     the connection is already broken from the proxy's perspective.
 *
 * Emits:
 *  - `scan-start` — scan cycle began (includes entry count)
 *  - `entry-evicted` — a zombie entry was evicted
 *  - `entry-alive` — upstream responded, entry evicted anyway
 *  - `scan-complete` — scan cycle finished (includes eviction count)
 */

export interface ZombieDetectorConfig {
  /** Scan interval in milliseconds. Default: 60_000 (60s). */
  scanIntervalMs: number;
  /** TCP probe timeout in milliseconds. Default: 3_000 (3s). */
  probeTimeoutMs: number;
  /** Whether to auto-start scanning on construction. */
  autoStart: boolean;
}

export interface ZombieScanResult {
  /** Total entries scanned. */
  scanned: number;
  /** Entries where upstream did not respond (true zombies). */
  zombiesEvicted: number;
  /** Entries where upstream responded but entry was evicted anyway. */
  aliveButEvicted: number;
  /** Scan duration in milliseconds. */
  durationMs: number;
}

interface FlowEntryView {
  flowId: string;
  upstreamAddr: string;
  proxySocketAlive: boolean;
}

// Minimal interface matching FlowTable's public API from flow-table.rs
// (re-implemented in TS for the monitoring subsystem).
interface FlowTableReader {
  getOrphans(): FlowEntryView[];
  evict(flowId: string): boolean;
}

export class ZombieDetector extends EventEmitter {
  private readonly config: ZombieDetectorConfig;
  private readonly flowTable: FlowTableReader;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private totalScans = 0;
  private totalZombiesEvicted = 0;

  constructor(flowTable: FlowTableReader, config?: Partial<ZombieDetectorConfig>) {
    super();
    this.flowTable = flowTable;
    this.config = {
      scanIntervalMs: config?.scanIntervalMs ?? 60_000,
      probeTimeoutMs: config?.probeTimeoutMs ?? 3_000,
      autoStart: config?.autoStart ?? false,
    };

    if (this.config.autoStart) {
      this.start();
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  /** Start periodic zombie scanning. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.scan(), this.config.scanIntervalMs);
    // Allow the process to exit even if the timer is active.
    if (this.timer.unref) this.timer.unref();
    this.emit('started');
  }

  /** Stop scanning. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit('stopped');
  }

  /** Run a single scan cycle (can also be called manually). */
  async scan(): Promise<ZombieScanResult> {
    if (this.scanning) {
      return { scanned: 0, zombiesEvicted: 0, aliveButEvicted: 0, durationMs: 0 };
    }
    this.scanning = true;
    const start = Date.now();

    const orphans = this.flowTable.getOrphans();
    this.emit('scan-start', { count: orphans.length });

    let zombiesEvicted = 0;
    let aliveButEvicted = 0;

    for (const entry of orphans) {
      try {
        const alive = await this.probeUpstream(entry.upstreamAddr);
        if (alive) {
          aliveButEvicted++;
          this.emit('entry-alive', { flowId: entry.flowId, upstream: entry.upstreamAddr });
        } else {
          zombiesEvicted++;
          this.emit('entry-evicted', { flowId: entry.flowId, upstream: entry.upstreamAddr });
        }
        this.flowTable.evict(entry.flowId);
      } catch {
        // Probe failed — treat as dead upstream, evict.
        zombiesEvicted++;
        this.flowTable.evict(entry.flowId);
        this.emit('entry-evicted', { flowId: entry.flowId, upstream: entry.upstreamAddr, error: true });
      }
    }

    const durationMs = Date.now() - start;
    this.totalScans++;
    this.totalZombiesEvicted += zombiesEvicted;

    const result: ZombieScanResult = {
      scanned: orphans.length,
      zombiesEvicted,
      aliveButEvicted,
      durationMs,
    };

    this.emit('scan-complete', result);
    this.scanning = false;
    return result;
  }

  // ── Metrics ────────────────────────────────────────────────────

  get metrics() {
    return {
      totalScans: this.totalScans,
      totalZombiesEvicted: this.totalZombiesEvicted,
      isScanning: this.scanning,
      started: this.timer !== null,
    };
  }

  // ── Private ────────────────────────────────────────────────────

  /**
   * Send a TCP keepalive probe to `upstreamAddr`.
   *
   * Returns `true` if the upstream responds (connection succeeds or gets
   * a RST — either way the upstream is reachable).  Returns `false` if
   * the connection times out (upstream is gone or network-partitioned).
   */
  private probeUpstream(upstreamAddr: string): Promise<boolean> {
    return new Promise((resolve) => {
      const [host, portStr] = upstreamAddr.split(':');
      const port = parseInt(portStr, 10);
      if (!host || isNaN(port)) {
        resolve(false);
        return;
      }

      const socket = net.createConnection({ host, port });

      const cleanup = () => {
        socket.removeAllListeners();
        socket.destroy();
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve(false); // timeout → upstream not responding
      }, this.config.probeTimeoutMs);

      socket.once('connect', () => {
        clearTimeout(timer);
        cleanup();
        resolve(true); // upstream accepted the connection
      });

      socket.once('error', () => {
        clearTimeout(timer);
        cleanup();
        // Connection refused (ECONNREFUSED) means the upstream port is
        // closed — the connection is definitely dead.  This still counts
        // as "alive" from the probe's perspective because we got a
        // definitive response (RST), not a timeout.
        resolve(true);
      });
    });
  }
}
