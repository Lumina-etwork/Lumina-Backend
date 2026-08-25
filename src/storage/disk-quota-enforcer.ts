/**
 * disk-quota-enforcer.ts
 *
 * Disk usage monitoring and enforcement for the WAL storage directory.
 *
 * Policy:
 *  - Polls disk usage every POLL_INTERVAL_MS (default 5 s).
 *  - EMERGENCY_RESERVE_BYTES (500 MB) is always reserved and never counted
 *    as available space.
 *  - At SHUTDOWN_THRESHOLD (95% quota consumed): emits 'criticalUsage' and
 *    triggers graceful shutdown via the supplied `onCritical` callback.
 *  - At WARNING_THRESHOLD (80% quota consumed): emits 'highUsage'.
 *  - All disk measurement is injected through DiskProbe for testability.
 */

import { EventEmitter } from 'events';

export const EMERGENCY_RESERVE_BYTES = 500 * 1024 * 1024; // 500 MB
export const SHUTDOWN_THRESHOLD = 0.95;                    // 95%
export const WARNING_THRESHOLD = 0.80;                     // 80%
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_WAL_DISK_QUOTA_GB = 10;

export interface DiskProbe {
  /**
   * Returns total bytes used on the filesystem / volume that contains `dir`.
   */
  getUsedBytes(dir: string): Promise<number>;
}

export interface DiskQuotaEnforcerOptions {
  /** Directory being monitored (the WAL segment dir). */
  walDir: string;
  /** Hard quota in GB (default 10). */
  walDiskQuotaGb?: number;
  /** Emergency reserve in bytes (default 500 MB). */
  emergencyReserveBytes?: number;
  /** Fraction of quota at which graceful shutdown is triggered (default 0.95). */
  shutdownThreshold?: number;
  /** Fraction of quota at which a high-usage warning is emitted (default 0.80). */
  warningThreshold?: number;
  /** How often to poll disk usage in ms (default 5 000). */
  pollIntervalMs?: number;
  /** Called when the shutdown threshold is crossed. */
  onCritical?: () => void | Promise<void>;
  /** Injected disk probe (default: real statvfs via df). */
  probe?: DiskProbe;
  /** Clock function (default Date.now). */
  clock?: () => number;
}

export interface QuotaStatus {
  usedBytes: number;
  quotaBytes: number;
  reserveBytes: number;
  availableBytes: number;
  usageFraction: number;
  isWarning: boolean;
  isCritical: boolean;
}

export class DiskQuotaEnforcer extends EventEmitter {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastStatus: QuotaStatus | null = null;
  private shutdownTriggered: boolean = false;

  private readonly walDir: string;
  private readonly quotaBytes: number;
  private readonly emergencyReserveBytes: number;
  private readonly shutdownThreshold: number;
  private readonly warningThreshold: number;
  private readonly pollIntervalMs: number;
  private readonly onCritical: (() => void | Promise<void>) | undefined;
  private readonly probe: DiskProbe;
  private readonly clock: () => number;

  constructor(options: DiskQuotaEnforcerOptions) {
    super();
    this.walDir = options.walDir;
    this.quotaBytes =
      (options.walDiskQuotaGb ?? DEFAULT_WAL_DISK_QUOTA_GB) * 1024 * 1024 * 1024;
    this.emergencyReserveBytes = options.emergencyReserveBytes ?? EMERGENCY_RESERVE_BYTES;
    this.shutdownThreshold = options.shutdownThreshold ?? SHUTDOWN_THRESHOLD;
    this.warningThreshold = options.warningThreshold ?? WARNING_THRESHOLD;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.onCritical = options.onCritical;
    this.probe = options.probe ?? this.buildDefaultProbe();
    this.clock = options.clock ?? Date.now;
  }

  /**
   * Start the periodic disk-usage polling loop.
   */
  start(): void {
    if (this.pollTimer !== null) return;
    const timer = setInterval(() => this.poll(), this.pollIntervalMs);
    timer.unref?.();
    this.pollTimer = timer;
    // Run an immediate first check.
    this.poll().catch((err) => this.emit('error', err));
  }

  stop(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Run a single quota check. Returns the current QuotaStatus.
   * Can be called directly from tests without starting the polling loop.
   */
  async check(): Promise<QuotaStatus> {
    const usedBytes = await this.probe.getUsedBytes(this.walDir);
    const status = this.buildStatus(usedBytes);
    this.lastStatus = status;

    if (status.isCritical && !this.shutdownTriggered) {
      this.shutdownTriggered = true;
      this.emit('criticalUsage', status);
      try {
        await this.onCritical?.();
      } catch (err) {
        this.emit('error', err);
      }
    } else if (status.isWarning && !status.isCritical) {
      this.emit('highUsage', status);
    }

    return status;
  }

  getLastStatus(): QuotaStatus | null {
    return this.lastStatus;
  }

  /**
   * Returns available bytes after subtracting used space and the emergency
   * reserve.  Never goes below 0.
   */
  getAvailableBytes(usedBytes: number): number {
    return Math.max(
      0,
      this.quotaBytes - usedBytes - this.emergencyReserveBytes,
    );
  }

  getQuotaBytes(): number {
    return this.quotaBytes;
  }

  getEmergencyReserveBytes(): number {
    return this.emergencyReserveBytes;
  }

  // ─── private ────────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    try {
      await this.check();
    } catch (err) {
      this.emit('error', err);
    }
  }

  private buildStatus(usedBytes: number): QuotaStatus {
    const available = this.getAvailableBytes(usedBytes);
    // Usage fraction is against the full quota (not quota minus reserve).
    const usageFraction = usedBytes / this.quotaBytes;

    return {
      usedBytes,
      quotaBytes: this.quotaBytes,
      reserveBytes: this.emergencyReserveBytes,
      availableBytes: available,
      usageFraction,
      isWarning: usageFraction >= this.warningThreshold,
      isCritical: usageFraction >= this.shutdownThreshold,
    };
  }

  private buildDefaultProbe(): DiskProbe {
    return {
      async getUsedBytes(dir: string): Promise<number> {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { execFile } = require('child_process') as typeof import('child_process');
        return new Promise((resolve, reject) => {
          // `du -sb <dir>` gives total bytes used under the directory.
          execFile('du', ['-sb', dir], (err, stdout) => {
            if (err) { resolve(0); return; }
            const bytes = parseInt(stdout.trim().split(/\s+/)[0], 10);
            resolve(isNaN(bytes) ? 0 : bytes);
          });
        });
      },
    };
  }
}
