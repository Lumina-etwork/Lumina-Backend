/**
 * TLS Acceptor Pool — Issue #118
 *
 * Manages a pool of TLS handshake workers with:
 *   - HalfOpenHandshakeMap: LRU-evicted map (max 10,000 entries, TTL 30s) that
 *     tracks in-progress handshakes so stale half-open connections are reaped
 *     before they tie up worker threads.
 *   - Worker pool: round-robin dispatching to N worker slots.
 *   - CPU budget integration: if TLS CPU > 20% of the worker budget, new
 *     handshakes are pushed to a deferred (secondary) queue.
 *   - Lifecycle events: start, complete, timeout.
 *   - Metrics: active count, success/failure rates, average CPU cost.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HandshakeEntry {
  /** Unique handshake identifier (typically `<clientAddr>:<serverPort>:<randomSuffix>`). */
  id: string
  /** Remote peer address. */
  clientAddr: string
  /** Epoch-ms when the handshake was initiated. */
  startedAt: number
  /** Epoch-ms when the entry expires and should be reaped (startedAt + TTL_MS). */
  expiresAt: number
  /** Whether the handshake has been resolved (success or failure). */
  resolved: boolean
  /** Optional per-handshake CPU microseconds recorded on completion. */
  cpuUs?: number
}

export interface WorkerSlot {
  id: number
  busy: boolean
  /** Approximate CPU fraction used for TLS work (0.0–1.0). */
  cpuFraction: number
}

export interface AcceptorPoolOptions {
  /** Maximum concurrent in-flight handshakes tracked in the half-open map. */
  maxHalfOpen?: number
  /** TTL in milliseconds for a half-open handshake entry before it is reaped. */
  halfOpenTtlMs?: number
  /** Number of worker slots in the pool. */
  workerCount?: number
  /** CPU fraction threshold above which handshakes are deferred (0.0–1.0). */
  cpuBudgetThreshold?: number
  /** Maximum entries in the deferred queue. */
  deferredQueueMax?: number
  /** Clock override for testing. */
  clock?: () => number
}

export interface HandshakeOutcome {
  id: string
  success: boolean
  cpuUs: number
  durationMs: number
}

export interface PoolMetrics {
  activeHandshakes: number
  successTotal: number
  failureTotal: number
  deferredTotal: number
  timedOutTotal: number
  successRate: number
  avgCpuUsPerHandshake: number
  deferredQueueDepth: number
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_HALF_OPEN = 10_000
const DEFAULT_HALF_OPEN_TTL_MS = 30_000        // 30 seconds
const DEFAULT_WORKER_COUNT = 4
const DEFAULT_CPU_BUDGET_THRESHOLD = 0.20       // 20 %
const DEFAULT_DEFERRED_QUEUE_MAX = 500

// ── HalfOpenHandshakeMap ──────────────────────────────────────────────────────

/**
 * Fixed-capacity LRU map that tracks in-progress ("half-open") TLS handshakes.
 *
 * Eviction policy:
 *   1. TTL expiry — any entry older than `ttlMs` is a zombie and is reaped on
 *      the next `reapExpired()` call (or lazily on insert when at capacity).
 *   2. LRU — when at capacity and no expired entries exist, the least-recently
 *      inserted entry is evicted to make room.
 *
 * The Map iteration order in JavaScript is insertion order, which makes it
 * trivial to implement LRU: the first key in the map is always the oldest.
 */
export class HalfOpenHandshakeMap {
  private readonly entries: Map<string, HandshakeEntry>
  private readonly maxSize: number
  private readonly ttlMs: number
  private readonly clock: () => number

  private timedOutCount = 0

  constructor(options: Pick<AcceptorPoolOptions, "maxHalfOpen" | "halfOpenTtlMs" | "clock"> = {}) {
    this.maxSize = options.maxHalfOpen ?? DEFAULT_MAX_HALF_OPEN
    this.ttlMs = options.halfOpenTtlMs ?? DEFAULT_HALF_OPEN_TTL_MS
    this.clock = options.clock ?? (() => Date.now())
    this.entries = new Map()
  }

  // ── Insertion ─────────────────────────────────────────────────────

  /**
   * Register a new half-open handshake.  If the map is at capacity, expired
   * entries are reaped first; if still full, the oldest entry is LRU-evicted.
   */
  start(id: string, clientAddr: string): HandshakeEntry {
    const now = this.clock()
    const entry: HandshakeEntry = {
      id,
      clientAddr,
      startedAt: now,
      expiresAt: now + this.ttlMs,
      resolved: false,
    }

    if (this.entries.has(id)) {
      // Re-use existing entry if the same ID is re-registered (idempotent).
      return this.entries.get(id)!
    }

    // Ensure capacity.
    if (this.entries.size >= this.maxSize) {
      this.reapExpired(now)
    }
    if (this.entries.size >= this.maxSize) {
      // Still full after reaping — evict the LRU (oldest) entry.
      const oldestKey = this.entries.keys().next().value
      if (oldestKey !== undefined) {
        const evicted = this.entries.get(oldestKey)!
        if (!evicted.resolved) {
          this.timedOutCount++
        }
        this.entries.delete(oldestKey)
      }
    }

    this.entries.set(id, entry)
    return entry
  }

  // ── Resolution ────────────────────────────────────────────────────

  /**
   * Mark a handshake as resolved (success or failure).
   * Returns the entry or `undefined` if it was already reaped.
   */
  resolve(id: string, outcome: Pick<HandshakeOutcome, "success" | "cpuUs">): HandshakeEntry | undefined {
    const entry = this.entries.get(id)
    if (!entry) return undefined

    entry.resolved = true
    entry.cpuUs = outcome.cpuUs

    // Move to end of map (refresh LRU position) by re-inserting.
    this.entries.delete(id)
    this.entries.set(id, entry)
    return entry
  }

  /**
   * Remove a resolved entry after the caller has processed the outcome.
   */
  delete(id: string): boolean {
    return this.entries.delete(id)
  }

  // ── Reaping ───────────────────────────────────────────────────────

  /**
   * Remove all entries whose TTL has expired.  Returns the list of reaped IDs.
   * Call this periodically (e.g., every second) to bound memory usage.
   */
  reapExpired(nowMs?: number): string[] {
    const now = nowMs ?? this.clock()
    const reaped: string[] = []

    for (const [id, entry] of this.entries) {
      if (now >= entry.expiresAt) {
        if (!entry.resolved) {
          this.timedOutCount++
        }
        this.entries.delete(id)
        reaped.push(id)
      }
    }

    return reaped
  }

  // ── Accessors ─────────────────────────────────────────────────────

  get(id: string): HandshakeEntry | undefined {
    return this.entries.get(id)
  }

  get size(): number {
    return this.entries.size
  }

  get timedOut(): number {
    return this.timedOutCount
  }

  /** All entries as a read-only snapshot (for diagnostics). */
  snapshot(): HandshakeEntry[] {
    return Array.from(this.entries.values())
  }
}

// ── TlsAcceptorPool ───────────────────────────────────────────────────────────

/**
 * Worker pool for TLS handshake acceptance.
 *
 * Responsibilities:
 *   - Route incoming connections to available worker slots.
 *   - Enforce the CPU budget: defer new handshakes when the pool average CPU
 *     share exceeds `cpuBudgetThreshold`.
 *   - Track handshake lifecycle via `HalfOpenHandshakeMap`.
 *   - Emit metrics.
 */
export class TlsAcceptorPool {
  private readonly halfOpen: HalfOpenHandshakeMap
  private readonly workers: WorkerSlot[]
  private readonly deferredQueue: Array<{ id: string; clientAddr: string; enqueuedAt: number }>
  private readonly options: Required<AcceptorPoolOptions>
  private readonly clock: () => number

  private successTotal = 0
  private failureTotal = 0
  private deferredTotal = 0
  private cpuUsTotal = 0

  constructor(options: AcceptorPoolOptions = {}) {
    this.options = {
      maxHalfOpen: DEFAULT_MAX_HALF_OPEN,
      halfOpenTtlMs: DEFAULT_HALF_OPEN_TTL_MS,
      workerCount: DEFAULT_WORKER_COUNT,
      cpuBudgetThreshold: DEFAULT_CPU_BUDGET_THRESHOLD,
      deferredQueueMax: DEFAULT_DEFERRED_QUEUE_MAX,
      clock: options.clock ?? (() => Date.now()),
      ...options,
    }
    this.clock = this.options.clock

    this.halfOpen = new HalfOpenHandshakeMap({
      maxHalfOpen: this.options.maxHalfOpen,
      halfOpenTtlMs: this.options.halfOpenTtlMs,
      clock: this.clock,
    })

    this.workers = Array.from({ length: this.options.workerCount }, (_, i) => ({
      id: i,
      busy: false,
      cpuFraction: 0.0,
    }))

    this.deferredQueue = []
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Accept an incoming TLS connection and route it to a worker.
   *
   * Returns `"deferred"` if the CPU budget is exceeded, `"accepted"` if a
   * worker slot was assigned, or `"queued"` if all workers are busy but the
   * connection was added to the deferred queue.
   */
  accept(id: string, clientAddr: string): "accepted" | "deferred" | "queued" | "dropped" {
    const now = this.clock()

    // ── CPU budget gate ───────────────────────────────────────────
    if (this.averageCpuFraction() > this.options.cpuBudgetThreshold) {
      return this.enqueueDeferred(id, clientAddr, now)
    }

    // ── Find an available worker ──────────────────────────────────
    const worker = this.nextAvailableWorker()
    if (!worker) {
      return this.enqueueDeferred(id, clientAddr, now)
    }

    // ── Begin handshake ───────────────────────────────────────────
    this.halfOpen.start(id, clientAddr)
    worker.busy = true
    return "accepted"
  }

  /**
   * Signal that a handshake has completed (success or failure).
   */
  complete(outcome: HandshakeOutcome, workerId: number): void {
    const entry = this.halfOpen.resolve(outcome.id, {
      success: outcome.success,
      cpuUs: outcome.cpuUs,
    })

    if (entry) {
      this.halfOpen.delete(outcome.id)
    }

    // Update worker state
    const worker = this.workers[workerId]
    if (worker) {
      worker.busy = false
      // Exponentially weighted moving average for CPU fraction.
      worker.cpuFraction = worker.cpuFraction * 0.9 + (outcome.cpuUs / 1_000_000) * 0.1
    }

    // Update aggregate metrics
    this.cpuUsTotal += outcome.cpuUs
    if (outcome.success) {
      this.successTotal++
    } else {
      this.failureTotal++
    }

    // Try to drain the deferred queue.
    this.drainDeferred()
  }

  /**
   * Periodically reap expired half-open handshakes.
   * Should be called every second by a housekeeping timer.
   */
  reap(): string[] {
    return this.halfOpen.reapExpired()
  }

  /**
   * Update the CPU fraction for a specific worker (called from the worker itself).
   */
  updateWorkerCpu(workerId: number, cpuFraction: number): void {
    const worker = this.workers[workerId]
    if (worker) {
      worker.cpuFraction = Math.max(0, Math.min(1, cpuFraction))
    }
  }

  /**
   * Snapshot of current pool metrics.
   */
  metrics(): PoolMetrics {
    const total = this.successTotal + this.failureTotal
    return {
      activeHandshakes: this.halfOpen.size,
      successTotal: this.successTotal,
      failureTotal: this.failureTotal,
      deferredTotal: this.deferredTotal,
      timedOutTotal: this.halfOpen.timedOut,
      successRate: total === 0 ? 1 : this.successTotal / total,
      avgCpuUsPerHandshake: this.successTotal === 0 ? 0 : this.cpuUsTotal / this.successTotal,
      deferredQueueDepth: this.deferredQueue.length,
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────

  private averageCpuFraction(): number {
    if (this.workers.length === 0) return 0
    const sum = this.workers.reduce((acc, w) => acc + w.cpuFraction, 0)
    return sum / this.workers.length
  }

  private nextAvailableWorker(): WorkerSlot | undefined {
    return this.workers.find((w) => !w.busy)
  }

  private enqueueDeferred(
    id: string,
    clientAddr: string,
    now: number,
  ): "deferred" | "dropped" {
    if (this.deferredQueue.length >= this.options.deferredQueueMax) {
      // Queue is also full — drop the connection.
      return "dropped"
    }
    this.deferredQueue.push({ id, clientAddr, enqueuedAt: now })
    this.deferredTotal++
    return "deferred"
  }

  private drainDeferred(): void {
    while (this.deferredQueue.length > 0) {
      if (this.averageCpuFraction() > this.options.cpuBudgetThreshold) break

      const worker = this.nextAvailableWorker()
      if (!worker) break

      const next = this.deferredQueue.shift()!
      this.halfOpen.start(next.id, next.clientAddr)
      worker.busy = true
    }
  }
}
