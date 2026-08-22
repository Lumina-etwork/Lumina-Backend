/**
 * Connection Rate Limiter — Issue #118
 *
 * Per-IP (and per-/24-subnet) token-bucket rate limiter for TLS connections.
 *
 * Designed to complement `tls-terminator.rs`: the TypeScript acceptor layer
 * calls this before handing off to the Rust TLS stack, providing an early
 * drop decision without deserializing a ClientHello.
 *
 * Features:
 *   - Token-bucket per exact IP and per /24 subnet (both checked; the stricter
 *     limit wins).
 *   - Configurable capacity / refill-per-second via constructor options.
 *   - LRU eviction when the bucket map exceeds `maxBuckets`.
 *   - Metrics: total allowed, rate-limited, and active connections per IP.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BucketPolicy {
  /** Maximum token capacity (also the burst ceiling). */
  capacity: number
  /** Tokens restored per second. */
  refillPerSecond: number
}

export interface RateLimitResult {
  allowed: boolean
  /** Tokens remaining after this check. */
  remaining: number
  /** Epoch-ms when the bucket will be full again. */
  resetTime: number
  /** Seconds to wait before retrying (0 if allowed). */
  retryAfterSeconds: number
  ip: string
  subnet: string
}

export interface ConnectionRateLimiterOptions {
  /** Per-exact-IP policy. */
  ipPolicy?: BucketPolicy
  /** Per-/24-subnet policy (aggregate across the subnet). */
  subnetPolicy?: BucketPolicy
  /** Maximum number of buckets in memory before LRU eviction kicks in. */
  maxBuckets?: number
  /** Clock override (returns epoch-ms). */
  clock?: () => number
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_IP_POLICY: BucketPolicy = {
  capacity: 20,           // burst of 20 connections
  refillPerSecond: 5,     // steady-state: 5 connections/s per IP
}

const DEFAULT_SUBNET_POLICY: BucketPolicy = {
  capacity: 50,           // 50 connections burst for the whole /24
  refillPerSecond: 10,    // 10 connections/s per /24
}

const DEFAULT_MAX_BUCKETS = 200_000

// ── Internal bucket ───────────────────────────────────────────────────────────

interface Bucket {
  tokens: number
  updatedAt: number
  /** Last time this bucket was accessed — used for LRU eviction. */
  lastSeenAt: number
}

// ── ConnectionRateLimiter ─────────────────────────────────────────────────────

export class ConnectionRateLimiter {
  private readonly ipBuckets: Map<string, Bucket>
  private readonly subnetBuckets: Map<string, Bucket>
  private readonly ipPolicy: BucketPolicy
  private readonly subnetPolicy: BucketPolicy
  private readonly maxBuckets: number
  private readonly clock: () => number

  // ── Metrics ───────────────────────────────────────────────────────
  private allowedTotal = 0
  private blockedTotal = 0
  private activeConnections: Map<string, number> = new Map()

  constructor(options: ConnectionRateLimiterOptions = {}) {
    this.ipPolicy = options.ipPolicy ?? DEFAULT_IP_POLICY
    this.subnetPolicy = options.subnetPolicy ?? DEFAULT_SUBNET_POLICY
    this.maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS
    this.clock = options.clock ?? (() => Date.now())
    this.ipBuckets = new Map()
    this.subnetBuckets = new Map()
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Check whether a new connection from `ip` is within rate limits.
   *
   * Both the per-IP and per-/24-subnet buckets are checked.  The connection is
   * allowed only if both pass.
   */
  check(ip: string): RateLimitResult {
    const now = this.clock()
    const subnet = toSubnet(ip)

    const ipResult = this.consumeBucket(this.ipBuckets, ip, this.ipPolicy, now)
    const subnetResult = this.consumeBucket(this.subnetBuckets, subnet, this.subnetPolicy, now)

    const allowed = ipResult.allowed && subnetResult.allowed
    const remaining = Math.min(ipResult.remaining, subnetResult.remaining)
    const resetTime = Math.max(ipResult.resetTime, subnetResult.resetTime)
    const retryAfterSeconds = allowed
      ? 0
      : Math.max(ipResult.retryAfterSeconds, subnetResult.retryAfterSeconds)

    if (allowed) {
      this.allowedTotal++
    } else {
      this.blockedTotal++
    }

    this.pruneIfNeeded(now)

    return { allowed, remaining, resetTime, retryAfterSeconds, ip, subnet }
  }

  /**
   * Record the start of an active connection (for active-connection tracking).
   */
  connectionOpened(ip: string): void {
    this.activeConnections.set(ip, (this.activeConnections.get(ip) ?? 0) + 1)
  }

  /**
   * Record the end of an active connection.
   */
  connectionClosed(ip: string): void {
    const current = this.activeConnections.get(ip) ?? 0
    if (current <= 1) {
      this.activeConnections.delete(ip)
    } else {
      this.activeConnections.set(ip, current - 1)
    }
  }

  /**
   * Active connection count for a specific IP.
   */
  activeCount(ip: string): number {
    return this.activeConnections.get(ip) ?? 0
  }

  /**
   * Current metrics snapshot.
   */
  metrics() {
    return {
      allowedTotal: this.allowedTotal,
      blockedTotal: this.blockedTotal,
      totalActiveConnections: Array.from(this.activeConnections.values()).reduce((a, b) => a + b, 0),
      ipBucketCount: this.ipBuckets.size,
      subnetBucketCount: this.subnetBuckets.size,
    }
  }

  /**
   * Reset all state (useful in tests).
   */
  reset(): void {
    this.ipBuckets.clear()
    this.subnetBuckets.clear()
    this.activeConnections.clear()
    this.allowedTotal = 0
    this.blockedTotal = 0
  }

  // ── Internal helpers ──────────────────────────────────────────────

  private consumeBucket(
    map: Map<string, Bucket>,
    key: string,
    policy: BucketPolicy,
    now: number,
  ): { allowed: boolean; remaining: number; resetTime: number; retryAfterSeconds: number } {
    const capacity = Math.max(1, policy.capacity)
    const refillPerSecond = Math.max(0.001, policy.refillPerSecond)

    const existing: Bucket = map.get(key) ?? {
      tokens: capacity,
      updatedAt: now,
      lastSeenAt: now,
    }

    // Refill
    const elapsedSeconds = Math.max(0, (now - existing.updatedAt) / 1000)
    const tokens = Math.min(capacity, existing.tokens + elapsedSeconds * refillPerSecond)

    const allowed = tokens >= 1
    const remaining = allowed ? tokens - 1 : tokens
    const resetInMs = Math.ceil(((capacity - remaining) / refillPerSecond) * 1000)
    const retryAfterSeconds = allowed
      ? 0
      : Math.max(1, Math.ceil((1 - remaining) / refillPerSecond))

    map.set(key, { tokens: remaining, updatedAt: now, lastSeenAt: now })

    return {
      allowed,
      remaining: Math.floor(remaining),
      resetTime: now + resetInMs,
      retryAfterSeconds,
    }
  }

  /**
   * Evict the 10% least-recently-seen entries when we hit the bucket cap.
   */
  private pruneIfNeeded(now: number): void {
    const totalBuckets = this.ipBuckets.size + this.subnetBuckets.size
    if (totalBuckets <= this.maxBuckets) return

    const evictCount = Math.ceil(this.maxBuckets * 0.05)
    pruneOldest(this.ipBuckets, evictCount)
    pruneOldest(this.subnetBuckets, evictCount)
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

/**
 * Extract the /24 subnet string from an IPv4 address string.
 * e.g. "10.0.1.200" → "10.0.1"
 * For IPv6 or non-standard formats, returns the full address unchanged.
 */
export function toSubnet(ip: string): string {
  const parts = ip.split(".")
  if (parts.length === 4) {
    return parts.slice(0, 3).join(".")
  }
  return ip
}

function pruneOldest(map: Map<string, Bucket>, count: number): void {
  const sorted = [...map.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)
  for (const [key] of sorted.slice(0, count)) {
    map.delete(key)
  }
}
