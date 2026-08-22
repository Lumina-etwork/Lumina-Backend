use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// TLS Handshake Amplification Protection — Issue #118
///
/// Defends against TLS ClientHello amplification attacks by applying multiple
/// layers of rate control at TLS termination time, before any CPU-heavy
/// crypto operations are performed.
///
/// Threat model:
///   An attacker sends a flood of TLS ClientHello messages from spoofed source
///   IPs.  Each ClientHello triggers expensive server-side crypto (RSA decrypt /
///   ECDH key exchange).  We mitigate by:
///
///   1. **Token-bucket per /24 subnet** — absorbs short legitimate bursts while
///      rate-limiting sustained flood traffic (50 handshakes/min, burst of 10).
///   2. **Failed-handshake tracker** — if a subnet accumulates >3 failures in
///      60 s, subsequent connections from that subnet must solve a 20-bit
///      hashcash proof-of-work puzzle before any TLS crypto is attempted.
///   3. **CPU budget gate** — if the per-worker TLS CPU share exceeds 20 % of
///      the worker budget, new handshakes are pushed to a lower-priority queue
///      rather than being rejected outright.
///   4. **Metrics** — emit success/failure rates, CPU cost per handshake, and
///      active handshake count for Prometheus scraping.

// ── Constants ─────────────────────────────────────────────────────────────────

/// Maximum handshake attempts per minute for a single /24 subnet.
const RATE_LIMIT_PER_MIN: u64 = 50;
/// Maximum burst of handshake attempts before rate limiting kicks in.
const RATE_LIMIT_BURST: u64 = 10;
/// Window for counting failed handshakes (seconds).
const FAILURE_WINDOW_SECS: u64 = 60;
/// Number of failures within the window before PoW is required.
const POW_FAILURE_THRESHOLD: u64 = 3;
/// Proof-of-work difficulty in bits (2^20 expected iterations).
const POW_DIFFICULTY_BITS: u32 = 20;
/// Refill rate: tokens per millisecond (50/min = 50/60000 ms).
const TOKENS_PER_MS: f64 = RATE_LIMIT_PER_MIN as f64 / 60_000.0;

// ── Token-bucket rate limiter ─────────────────────────────────────────────────

/// Per-/24-subnet token bucket.
#[derive(Debug)]
struct SubnetBucket {
    /// Current token count (fractional).
    tokens: f64,
    /// Last refill timestamp.
    last_refill: Instant,
}

impl SubnetBucket {
    fn new() -> Self {
        Self {
            tokens: RATE_LIMIT_BURST as f64,
            last_refill: Instant::now(),
        }
    }

    /// Refill tokens based on elapsed time, then attempt to consume one.
    /// Returns `true` if the handshake attempt is allowed.
    fn try_consume(&mut self) -> bool {
        let now = Instant::now();
        let elapsed_ms = now.duration_since(self.last_refill).as_millis() as f64;
        self.tokens = (self.tokens + elapsed_ms * TOKENS_PER_MS)
            .min(RATE_LIMIT_BURST as f64);
        self.last_refill = now;

        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

// ── Failed-handshake tracker ──────────────────────────────────────────────────

/// Tracks failed handshakes per subnet to decide whether PoW is required.
#[derive(Debug)]
struct FailureRecord {
    /// Number of failures in the current window.
    count: u64,
    /// When this window started.
    window_start: Instant,
}

impl FailureRecord {
    fn new() -> Self {
        Self {
            count: 0,
            window_start: Instant::now(),
        }
    }

    /// Record a failure, resetting the window if it has expired.
    fn record(&mut self) {
        let now = Instant::now();
        if now.duration_since(self.window_start) > Duration::from_secs(FAILURE_WINDOW_SECS) {
            self.count = 0;
            self.window_start = now;
        }
        self.count += 1;
    }

    /// Returns `true` if the subnet has exceeded the PoW threshold.
    fn requires_pow(&self) -> bool {
        let now = Instant::now();
        if now.duration_since(self.window_start) > Duration::from_secs(FAILURE_WINDOW_SECS) {
            return false; // window expired — clear slate
        }
        self.count > POW_FAILURE_THRESHOLD
    }
}

// ── Proof-of-work challenge ───────────────────────────────────────────────────

/// A 20-bit hashcash-style PoW challenge issued to abusive subnets.
///
/// The client must find a nonce N such that:
///   SHA-256( challenge_token || N.to_le_bytes() )
/// has at least `difficulty_bits` leading zero bits.
#[derive(Debug, Clone)]
pub struct PowChallenge {
    /// Opaque challenge token (32 random bytes, base64-encoded in the wire format).
    pub token: [u8; 32],
    /// Required leading zero bits.
    pub difficulty_bits: u32,
    /// When this challenge was issued (for expiry enforcement).
    pub issued_at: Instant,
}

impl PowChallenge {
    /// Create a new challenge with a fresh random token.
    pub fn new() -> Self {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        // Deterministic-ish seed from current time for stub — real code uses
        // a CSPRNG (e.g. `rand::thread_rng().fill_bytes(&mut token)`).
        let mut token = [0u8; 32];
        let seed = Instant::now().elapsed().subsec_nanos();
        let mut h = DefaultHasher::new();
        seed.hash(&mut h);
        let v = h.finish().to_le_bytes();
        token[..8].copy_from_slice(&v);
        Self {
            token,
            difficulty_bits: POW_DIFFICULTY_BITS,
            issued_at: Instant::now(),
        }
    }

    /// Verify that the client-supplied nonce satisfies the puzzle.
    ///
    /// Real implementation uses a constant-time SHA-256; this stub performs
    /// the structural check only.
    pub fn verify(&self, nonce: u64) -> bool {
        // Concatenate token || nonce (little-endian).
        let mut input = Vec::with_capacity(40);
        input.extend_from_slice(&self.token);
        input.extend_from_slice(&nonce.to_le_bytes());

        // Compute SHA-256 (stub: use a simple XOR-fold for compilation without
        // ring/sha2 dependency; replace with `sha2::Sha256::digest(&input)` in
        // production).
        let hash = stub_sha256(&input);
        leading_zero_bits(&hash) >= self.difficulty_bits
    }
}

impl Default for PowChallenge {
    fn default() -> Self {
        Self::new()
    }
}

/// Stub hash (XOR-fold into 32 bytes) — replace with SHA-256 in production.
fn stub_sha256(input: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, b) in input.iter().enumerate() {
        out[i % 32] ^= b.wrapping_add(i as u8);
    }
    out
}

/// Count the number of leading zero bits in a 32-byte hash.
fn leading_zero_bits(hash: &[u8; 32]) -> u32 {
    let mut bits = 0u32;
    for &byte in hash.iter() {
        if byte == 0 {
            bits += 8;
        } else {
            bits += byte.leading_zeros();
            break;
        }
    }
    bits
}

// ── Metrics ───────────────────────────────────────────────────────────────────

/// Atomically-updated counters exposed to Prometheus (or any scraper).
#[derive(Debug, Default)]
pub struct TlsTerminatorMetrics {
    /// Total handshakes accepted by the rate limiter.
    pub handshakes_allowed: AtomicU64,
    /// Handshakes rejected by the rate limiter (token bucket exhausted).
    pub handshakes_rate_limited: AtomicU64,
    /// Handshakes deferred to the secondary queue due to CPU pressure.
    pub handshakes_deferred: AtomicU64,
    /// Handshakes that completed successfully (TLS established).
    pub handshakes_succeeded: AtomicU64,
    /// Handshakes that failed (alert, bad cert, timeout, etc.).
    pub handshakes_failed: AtomicU64,
    /// PoW challenges issued.
    pub pow_challenges_issued: AtomicU64,
    /// PoW challenges solved by client.
    pub pow_challenges_solved: AtomicU64,
    /// PoW challenges failed (wrong nonce or expired).
    pub pow_challenges_failed: AtomicU64,
    /// Cumulative CPU microseconds consumed by TLS handshake processing.
    pub cpu_us_total: AtomicU64,
    /// Currently active (in-progress) handshakes.
    pub active_handshakes: AtomicU64,
}

impl TlsTerminatorMetrics {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot(&self) -> TlsMetricsSnapshot {
        TlsMetricsSnapshot {
            handshakes_allowed: self.handshakes_allowed.load(Ordering::Relaxed),
            handshakes_rate_limited: self.handshakes_rate_limited.load(Ordering::Relaxed),
            handshakes_deferred: self.handshakes_deferred.load(Ordering::Relaxed),
            handshakes_succeeded: self.handshakes_succeeded.load(Ordering::Relaxed),
            handshakes_failed: self.handshakes_failed.load(Ordering::Relaxed),
            pow_challenges_issued: self.pow_challenges_issued.load(Ordering::Relaxed),
            pow_challenges_solved: self.pow_challenges_solved.load(Ordering::Relaxed),
            pow_challenges_failed: self.pow_challenges_failed.load(Ordering::Relaxed),
            cpu_us_total: self.cpu_us_total.load(Ordering::Relaxed),
            active_handshakes: self.active_handshakes.load(Ordering::Relaxed),
        }
    }

    /// CPU microseconds per successful handshake (approximate).
    pub fn avg_cpu_us_per_handshake(&self) -> f64 {
        let succeeded = self.handshakes_succeeded.load(Ordering::Relaxed);
        if succeeded == 0 {
            return 0.0;
        }
        self.cpu_us_total.load(Ordering::Relaxed) as f64 / succeeded as f64
    }

    /// Handshake success rate as a fraction in [0, 1].
    pub fn success_rate(&self) -> f64 {
        let total = self.handshakes_succeeded.load(Ordering::Relaxed)
            + self.handshakes_failed.load(Ordering::Relaxed);
        if total == 0 {
            return 1.0;
        }
        self.handshakes_succeeded.load(Ordering::Relaxed) as f64 / total as f64
    }
}

/// Point-in-time snapshot (all fields are plain u64 for easy serialization).
#[derive(Debug, Clone)]
pub struct TlsMetricsSnapshot {
    pub handshakes_allowed: u64,
    pub handshakes_rate_limited: u64,
    pub handshakes_deferred: u64,
    pub handshakes_succeeded: u64,
    pub handshakes_failed: u64,
    pub pow_challenges_issued: u64,
    pub pow_challenges_solved: u64,
    pub pow_challenges_failed: u64,
    pub cpu_us_total: u64,
    pub active_handshakes: u64,
}

// ── Decision type ─────────────────────────────────────────────────────────────

/// Outcome of `TlsTerminator::check_handshake`.
#[derive(Debug, PartialEq, Eq)]
pub enum HandshakeDecision {
    /// Proceed immediately — rate limit not exceeded, no PoW required.
    Allow,
    /// Drop the connection — token bucket is empty.
    RateLimit,
    /// Issue a PoW challenge before continuing.
    RequirePoW(PowNonce),
    /// Defer: push to secondary queue due to CPU pressure.
    Defer,
}

/// Placeholder nonce type returned with `RequirePoW`.
#[derive(Debug, PartialEq, Eq)]
pub struct PowNonce(pub u64);

// ── TlsTerminator ─────────────────────────────────────────────────────────────

/// Central TLS termination controller.
///
/// One instance per worker thread.  The caller:
///
///   1. Calls `check_handshake(source_ip, cpu_fraction)` before doing any TLS
///      crypto.  Acts on the returned `HandshakeDecision`.
///   2. If the decision is `Allow`, calls `begin_handshake()` to increment the
///      active-handshake counter.
///   3. After the handshake finishes, calls `end_handshake(success, cpu_us)`.
pub struct TlsTerminator {
    /// Token buckets keyed by /24 subnet (first 3 octets packed into a u32).
    buckets: HashMap<u32, SubnetBucket>,
    /// Per-subnet failure counters.
    failures: HashMap<u32, FailureRecord>,
    /// Metrics exported to Prometheus.
    pub metrics: TlsTerminatorMetrics,
}

impl TlsTerminator {
    pub fn new() -> Self {
        Self {
            buckets: HashMap::new(),
            failures: HashMap::new(),
            metrics: TlsTerminatorMetrics::new(),
        }
    }

    // ── Public API ────────────────────────────────────────────────────

    /// Evaluate whether a new TLS handshake from `source_ip` should be allowed.
    ///
    /// * `source_ip`    — the IPv4 address of the connecting peer.
    /// * `cpu_fraction` — current TLS CPU share of this worker (0.0–1.0).
    ///
    /// The decision does NOT include the actual TLS handshake — the caller must
    /// check the `HandshakeDecision` and act accordingly.
    pub fn check_handshake(
        &mut self,
        source_ip: Ipv4Addr,
        cpu_fraction: f64,
    ) -> HandshakeDecision {
        let subnet = subnet_key(source_ip);

        // ── 1. CPU budget gate ────────────────────────────────────────
        if cpu_fraction > 0.20 {
            self.metrics.handshakes_deferred.fetch_add(1, Ordering::Relaxed);
            return HandshakeDecision::Defer;
        }

        // ── 2. Token-bucket rate limiter ──────────────────────────────
        let bucket = self.buckets.entry(subnet).or_insert_with(SubnetBucket::new);
        if !bucket.try_consume() {
            self.metrics.handshakes_rate_limited.fetch_add(1, Ordering::Relaxed);
            return HandshakeDecision::RateLimit;
        }

        // ── 3. PoW gate ───────────────────────────────────────────────
        if self.subnet_requires_pow(subnet) {
            let challenge = PowChallenge::new();
            let nonce = PowNonce(u64::from_le_bytes(challenge.token[..8].try_into().unwrap_or([0u8; 8])));
            self.metrics.pow_challenges_issued.fetch_add(1, Ordering::Relaxed);
            return HandshakeDecision::RequirePoW(nonce);
        }

        // ── 4. Allow ──────────────────────────────────────────────────
        self.metrics.handshakes_allowed.fetch_add(1, Ordering::Relaxed);
        HandshakeDecision::Allow
    }

    /// Mark the start of an active handshake (call after `Allow` decision).
    pub fn begin_handshake(&self) {
        self.metrics.active_handshakes.fetch_add(1, Ordering::Relaxed);
    }

    /// Mark the end of a handshake.
    ///
    /// * `source_ip` — used to update the failure tracker.
    /// * `succeeded` — whether the TLS handshake completed successfully.
    /// * `cpu_us`    — microseconds of CPU consumed by this handshake.
    pub fn end_handshake(&mut self, source_ip: Ipv4Addr, succeeded: bool, cpu_us: u64) {
        self.metrics.active_handshakes.fetch_sub(1, Ordering::Relaxed);
        self.metrics.cpu_us_total.fetch_add(cpu_us, Ordering::Relaxed);

        if succeeded {
            self.metrics.handshakes_succeeded.fetch_add(1, Ordering::Relaxed);
        } else {
            self.metrics.handshakes_failed.fetch_add(1, Ordering::Relaxed);
            let subnet = subnet_key(source_ip);
            self.failures
                .entry(subnet)
                .or_insert_with(FailureRecord::new)
                .record();
        }
    }

    /// Validate a client-submitted PoW nonce for the given source IP.
    pub fn verify_pow(&mut self, source_ip: Ipv4Addr, nonce: u64) -> bool {
        let challenge = PowChallenge::new(); // In production: look up the stored challenge
        let ok = challenge.verify(nonce);
        if ok {
            self.metrics.pow_challenges_solved.fetch_add(1, Ordering::Relaxed);
            // Reset failure count after successful PoW
            let subnet = subnet_key(source_ip);
            self.failures.remove(&subnet);
        } else {
            self.metrics.pow_challenges_failed.fetch_add(1, Ordering::Relaxed);
        }
        ok
    }

    // ── Internal helpers ──────────────────────────────────────────────

    fn subnet_requires_pow(&self, subnet: u32) -> bool {
        self.failures
            .get(&subnet)
            .map(|f| f.requires_pow())
            .unwrap_or(false)
    }

    /// Evict buckets and failure records that are no longer actively used.
    /// Call periodically (e.g., once per minute) to bound memory usage.
    pub fn gc(&mut self) {
        let stale_cutoff = Duration::from_secs(FAILURE_WINDOW_SECS * 2);
        self.failures.retain(|_, rec| {
            Instant::now().duration_since(rec.window_start) < stale_cutoff
        });
        // Buckets are small; GC only when count is large.
        if self.buckets.len() > 100_000 {
            self.buckets.clear();
        }
    }
}

impl Default for TlsTerminator {
    fn default() -> Self {
        Self::new()
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Collapse an IPv4 address into its /24 subnet key (first 3 octets → u32).
fn subnet_key(ip: Ipv4Addr) -> u32 {
    let o = ip.octets();
    ((o[0] as u32) << 16) | ((o[1] as u32) << 8) | (o[2] as u32)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(a: u8, b: u8, c: u8, d: u8) -> Ipv4Addr {
        Ipv4Addr::new(a, b, c, d)
    }

    #[test]
    fn subnet_key_collapses_last_octet() {
        assert_eq!(subnet_key(ip(10, 0, 1, 1)), subnet_key(ip(10, 0, 1, 200)));
        assert_ne!(subnet_key(ip(10, 0, 1, 1)), subnet_key(ip(10, 0, 2, 1)));
    }

    #[test]
    fn allows_burst_then_rate_limits() {
        let mut t = TlsTerminator::new();
        let src = ip(1, 2, 3, 4);
        // First BURST attempts should be allowed
        let mut allowed = 0u64;
        for _ in 0..(RATE_LIMIT_BURST + 2) {
            if t.check_handshake(src, 0.0) == HandshakeDecision::Allow {
                allowed += 1;
            }
        }
        assert_eq!(allowed, RATE_LIMIT_BURST, "exactly burst tokens consumed");
    }

    #[test]
    fn defers_when_cpu_over_budget() {
        let mut t = TlsTerminator::new();
        let decision = t.check_handshake(ip(1, 2, 3, 4), 0.25);
        assert_eq!(decision, HandshakeDecision::Defer);
        assert_eq!(t.metrics.handshakes_deferred.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn cpu_under_budget_allows() {
        let mut t = TlsTerminator::new();
        let decision = t.check_handshake(ip(1, 2, 3, 4), 0.10);
        assert_eq!(decision, HandshakeDecision::Allow);
    }

    #[test]
    fn failure_tracking_triggers_pow() {
        let mut t = TlsTerminator::new();
        let src = ip(10, 0, 0, 1);

        // Exhaust the burst first so we can record failures without
        // hitting the rate limit on the final check.
        for _ in 0..RATE_LIMIT_BURST {
            t.check_handshake(src, 0.0);
            t.begin_handshake();
        }

        // Refill one token manually by resetting the bucket.
        let subnet = subnet_key(src);
        t.buckets.insert(subnet, SubnetBucket::new());

        // Record enough failures to trigger PoW.
        for _ in 0..=POW_FAILURE_THRESHOLD {
            t.end_handshake(src, false, 0);
        }

        // The next check on a fresh bucket should require PoW.
        let decision = t.check_handshake(src, 0.0);
        assert!(
            matches!(decision, HandshakeDecision::RequirePoW(_)),
            "expected RequirePoW, got {:?}",
            decision
        );
        assert_eq!(t.metrics.pow_challenges_issued.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn begin_end_handshake_updates_metrics() {
        let mut t = TlsTerminator::new();
        let src = ip(1, 2, 3, 4);
        t.check_handshake(src, 0.0);
        t.begin_handshake();
        assert_eq!(t.metrics.active_handshakes.load(Ordering::Relaxed), 1);
        t.end_handshake(src, true, 5_000);
        assert_eq!(t.metrics.active_handshakes.load(Ordering::Relaxed), 0);
        assert_eq!(t.metrics.handshakes_succeeded.load(Ordering::Relaxed), 1);
        assert_eq!(t.metrics.cpu_us_total.load(Ordering::Relaxed), 5_000);
    }

    #[test]
    fn metrics_success_rate() {
        let mut t = TlsTerminator::new();
        let src = ip(1, 2, 3, 4);
        t.end_handshake(src, true, 0);
        t.end_handshake(src, true, 0);
        t.end_handshake(src, false, 0);
        // 2 successes / 3 total ≈ 0.666
        let rate = t.metrics.success_rate();
        assert!((rate - 2.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn leading_zero_bits_all_zeros() {
        let hash = [0u8; 32];
        assert_eq!(leading_zero_bits(&hash), 256);
    }

    #[test]
    fn leading_zero_bits_first_byte_0x80() {
        let mut hash = [0u8; 32];
        hash[0] = 0x80; // 1000_0000 — 0 leading zeros
        assert_eq!(leading_zero_bits(&hash), 0);
    }

    #[test]
    fn leading_zero_bits_first_byte_0x0f() {
        let mut hash = [0u8; 32];
        hash[0] = 0x0f; // 0000_1111 — 4 leading zeros
        assert_eq!(leading_zero_bits(&hash), 4);
    }

    #[test]
    fn gc_clears_failure_records() {
        let mut t = TlsTerminator::new();
        let src = ip(192, 168, 1, 1);
        for _ in 0..5 {
            t.end_handshake(src, false, 0);
        }
        assert!(!t.failures.is_empty());
        t.gc();
        // GC should not remove fresh records — the window hasn't expired.
        // Insert an artificially old record to test eviction.
        let subnet = subnet_key(src);
        t.failures.get_mut(&subnet).unwrap().window_start =
            Instant::now() - Duration::from_secs(FAILURE_WINDOW_SECS * 3);
        t.gc();
        assert!(t.failures.is_empty(), "stale failure record not evicted");
    }
}
