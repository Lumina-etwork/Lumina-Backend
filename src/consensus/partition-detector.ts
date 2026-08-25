/**
 * partition-detector.ts
 *
 * Failure detector for network partition events.
 *
 * Mechanism:
 *  - Each peer must send a heartbeat within PARTITION_DETECT_TIMEOUT_MS (30 s).
 *  - If the number of unresponsive peers causes the quorum to be lost
 *    (more than half the peers are unreachable), a 'partition' event fires.
 *  - A 'heal' event fires when quorum is restored.
 *
 * On 'partition':
 *  - All registered onPartition callbacks are invoked (e.g. WalWriter switches
 *    to reduced-throughput mode, AckWatermark freezes, archive spill starts).
 *
 * On 'heal':
 *  - All registered onHeal callbacks are invoked.
 *  - The protocol triggers prioritised archive replay via the supplied
 *    `triggerReplay` function before signalling normal resumption.
 *
 * The detector is fully injectable (clock, timer factories) so tests run in
 * fake-timer environments without modification.
 */

import { EventEmitter } from 'events';

export const PARTITION_DETECT_TIMEOUT_MS = 30_000;

export type PartitionCallback = () => void | Promise<void>;
export type HealCallback = (highestLsn: bigint) => void | Promise<void>;

export interface PeerState {
  peerId: string;
  lastHeartbeatAt: number;
  reachable: boolean;
}

export interface PartitionDetectorOptions {
  /** Peer IDs that form the replica set (excluding self). */
  peers: string[];
  /** Called when quorum is lost. */
  onPartition?: PartitionCallback;
  /** Called when quorum is restored. */
  onHeal?: HealCallback;
  /**
   * Called on heal to replay archived segments before resuming normal ops.
   * Must resolve to the highest LSN replayed.
   */
  triggerReplay?: () => Promise<bigint>;
  /** Heartbeat timeout in ms (default 30 000). */
  timeoutMs?: number;
  /** Clock function (default Date.now). */
  clock?: () => number;
  /** Polling interval for the watchdog (default 1 000 ms). */
  pollIntervalMs?: number;
}

export class PartitionDetector extends EventEmitter {
  private peerStates: Map<string, PeerState> = new Map();
  private partitioned: boolean = false;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  private readonly peers: string[];
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly clock: () => number;
  private readonly onPartitionCb: PartitionCallback | undefined;
  private readonly onHealCb: HealCallback | undefined;
  private readonly triggerReplay: (() => Promise<bigint>) | undefined;

  constructor(options: PartitionDetectorOptions) {
    super();
    this.peers = options.peers;
    this.timeoutMs = options.timeoutMs ?? PARTITION_DETECT_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.clock = options.clock ?? Date.now;
    this.onPartitionCb = options.onPartition;
    this.onHealCb = options.onHeal;
    this.triggerReplay = options.triggerReplay;

    // Initialise all peers as reachable with the current time.
    const now = this.clock();
    for (const peerId of this.peers) {
      this.peerStates.set(peerId, { peerId, lastHeartbeatAt: now, reachable: true });
    }
  }

  /**
   * Start the periodic watchdog that checks for timed-out peers.
   */
  start(): void {
    if (this.watchdogTimer !== null) return;
    const timer = setInterval(() => this.checkPeers(), this.pollIntervalMs);
    timer.unref?.();
    this.watchdogTimer = timer;
  }

  stop(): void {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /**
   * Record a heartbeat received from a peer.
   * Updates lastHeartbeatAt and may trigger a heal if we were partitioned.
   */
  receiveHeartbeat(peerId: string): void {
    const state = this.peerStates.get(peerId);
    if (!state) return;

    state.lastHeartbeatAt = this.clock();
    state.reachable = true;
    // Reachability is re-evaluated on the next watchdog poll cycle.
    // No immediate checkPeers() call here — avoids concurrent async
    // invocations racing with the periodic poll.
  }

  isPartitioned(): boolean {
    return this.partitioned;
  }

  getPeerStates(): Map<string, PeerState> {
    return new Map(this.peerStates);
  }

  /**
   * Returns the count of currently unreachable peers.
   */
  getUnreachableCount(): number {
    let count = 0;
    for (const state of this.peerStates.values()) {
      if (!state.reachable) count += 1;
    }
    return count;
  }

  // ─── private ────────────────────────────────────────────────────────────────

  private async checkPeers(): Promise<void> {
    const now = this.clock();
    let unreachable = 0;

    for (const state of this.peerStates.values()) {
      const timedOut = now - state.lastHeartbeatAt > this.timeoutMs;
      if (timedOut) {
        state.reachable = false;
      }
      if (!state.reachable) unreachable += 1;
    }

    const total = this.peers.length;
    // Quorum is lost when more than half the peers are unreachable.
    const quorumLost = unreachable > Math.floor(total / 2);

    if (quorumLost && !this.partitioned) {
      this.partitioned = true;
      this.emit('partition', { unreachable, total });
      try {
        await this.onPartitionCb?.();
      } catch (err) {
        this.emit('error', err);
      }
    } else if (!quorumLost && this.partitioned) {
      this.partitioned = false;

      // Prioritised archive replay before signalling heal.
      let highestLsn = 0n;
      if (this.triggerReplay) {
        try {
          highestLsn = await this.triggerReplay();
        } catch (err) {
          this.emit('replayError', err);
        }
      }

      this.emit('heal', { highestLsn });
      try {
        await this.onHealCb?.(highestLsn);
      } catch (err) {
        this.emit('error', err);
      }
    }
  }
}
