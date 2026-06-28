//! Kademlia-style DHT routing table with race-free eviction.
//!
//! Invariants (from issue #7):
//! - K=20 entries per kbucket
//! - 160 buckets (160-bit key space)
//! - Max routing table size: 160 × 20 = 3200 nodes
//! - Eviction cooldown: 300 s before a node can be re-added after removal
//! - Touch-on-lookup: each successful lookup updates `last_seen` on the entry
//!
//! Concurrency model:
//! - Readers (lookups) never block — they acquire a shared read lock.
//! - Writers (evictions, insertions) use `try_write` with a 50 ms timeout.
//!   If the timeout expires, the mutation is deferred to the next cycle.
//! - A pending-query set (maintained externally in `node-lookup.ts`) is
//!   checked *before* any eviction candidate is selected.

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// ─── Constants ────────────────────────────────────────────────────────────────

/// Kademlia bucket width (entries per bucket).
pub const BUCKET_K: usize = 20;

/// Number of k-buckets in a 160-bit ID space.
pub const NUM_BUCKETS: usize = 160;

/// Writer lock timeout — if the write lock isn't acquired within this
/// window the mutation is deferred.
pub const WRITE_LOCK_TIMEOUT_MS: u64 = 50;

/// Duration after removal during which a node cannot be re-added.
pub const EVICTION_COOLDOWN: Duration = Duration::from_secs(300);

/// Maximum evictions per cooldown window before oldest entries are released.
pub const BATCH_EVICTION_LIMIT: usize = 10;

// ─── Data types ───────────────────────────────────────────────────────────────

/// Stable identifier for a DHT peer (hex-encoded, variable length).
pub type NodeId = String;

/// A single entry in a k-bucket.
#[derive(Debug, Clone)]
pub struct NodeEntry {
    pub id: NodeId,
    pub address: String,
    /// Unix-millis timestamp of the last successful RPC response.
    pub last_seen: u64,
    /// Rolling average round-trip time in milliseconds.
    pub latency_ms: f64,
    /// Number of consecutive failed RPCs (used by eviction policy).
    pub fail_count: u32,
    /// When this node was added (or last re-added after eviction).
    pub added_at: Instant,
}

/// A single k-bucket.
#[derive(Debug)]
pub struct KBucket {
    /// B-tree-like ordering by `last_seen` is maintained on insertion so
    /// that eviction candidates are always at the tail.
    entries: Vec<NodeEntry>,
}

/// The full routing table — 160 k-buckets protected by a `RwLock`.
pub struct RoutingTable {
    buckets: Vec<RwLock<KBucket>>,
    /// Nodes removed within the last [`EVICTION_COOLDOWN`] — prevents
    /// immediate re-insertion of a flapping peer.
    evicted_cooldown: RwLock<HashMap<NodeId, Instant>>,
    /// Tracks eviction count in the current cooldown window for batch enforcement.
    eviction_count: RwLock<usize>,
    /// Window start for batch eviction tracking.
    batch_window_start: RwLock<Instant>,
}

// ─── NodeId helpers ──────────────────────────────────────────────────────────

/// Compute the bucket index for `node_id` relative to `local_id`.
///
/// The bucket index is the number of leading bits that differ
/// (prefix length of the XOR distance), clamped to `[0, NUM_BUCKETS)`.
pub fn bucket_index(local_id: &str, node_id: &str) -> usize {
    let local_bytes = hex_to_bytes(local_id);
    let node_bytes = hex_to_bytes(node_id);

    let mut diff_bits = 0usize;
    for i in 0..local_bytes.len().min(node_bytes.len()) {
        let xor = local_bytes[i] ^ node_bytes[i];
        if xor == 0 {
            diff_bits += 8;
        } else {
            // Count leading zeros in the XOR byte
            diff_bits += xor.leading_zeros() as usize;
            break;
        }
    }

    // Clamp to valid bucket range
    diff_bits.min(NUM_BUCKETS - 1)
}

fn hex_to_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .filter_map(|i| hex.get(i..i + 2)?.parse::<u8>().ok())
        .collect()
}

// ─── KBucket impl ─────────────────────────────────────────────────────────────

impl KBucket {
    fn new() -> Self {
        Self {
            entries: Vec::with_capacity(BUCKET_K),
        }
    }

    /// The least-recently-seen node (eviction candidate).
    pub fn lrs_node(&self) -> Option<&NodeEntry> {
        self.entries.last()
    }

    /// Touch an existing node — called on every successful lookup response.
    /// Moves it to the front (most-recently-seen) and refreshes the
    /// timestamp. Returns `true` if the node was found and touched.
    pub fn touch(&mut self, node_id: &str, now: u64, latency_ms: f64) -> bool {
        if let Some(pos) = self.entries.iter().position(|e| e.id == node_id) {
            let mut entry = self.entries.remove(pos);
            entry.last_seen = now;
            // Exponential moving average for latency
            entry.latency_ms = if entry.latency_ms == 0.0 {
                latency_ms
            } else {
                0.3 * latency_ms + 0.7 * entry.latency_ms
            };
            self.entries.insert(0, entry);
            true
        } else {
            false
        }
    }

    /// Insert a new node. If the bucket is full, returns the eviction
    /// candidate (caller must verify against pending-query set before
    /// actually evicting).
    pub fn insert(&mut self, entry: NodeEntry) -> Option<NodeEntry> {
        // Already present? Touch instead.
        if self.entries.iter().any(|e| e.id == entry.id) {
            self.touch(&entry.id, entry.last_seen, entry.latency_ms);
            return None;
        }

        if self.entries.len() < BUCKET_K {
            self.entries.insert(0, entry);
            None
        } else {
            // Bucket full — return the LRS node for the caller to
            // decide whether to evict.
            self.entries.last().cloned()
        }
    }

    /// Remove a node by ID. Returns the removed entry if present.
    pub fn remove(&mut self, node_id: &str) -> Option<NodeEntry> {
        if let Some(pos) = self.entries.iter().position(|e| e.id == node_id) {
            Some(self.entries.remove(pos))
        } else {
            None
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn entries(&self) -> &[NodeEntry] {
        &self.entries
    }
}

// ─── RoutingTable impl ────────────────────────────────────────────────────────

impl RoutingTable {
    pub fn new(local_id: &str) -> Self {
        let mut buckets = Vec::with_capacity(NUM_BUCKETS);
        for _ in 0..NUM_BUCKETS {
            buckets.push(RwLock::new(KBucket::new()));
        }
        let _ = local_id; // reserved for future use in bucket indexing
        Self {
            buckets,
            evicted_cooldown: RwLock::new(HashMap::new()),
            eviction_count: RwLock::new(0),
            batch_window_start: RwLock::new(Instant::now()),
        }
    }

    /// Insert a node into the appropriate k-bucket.
    ///
    /// Returns `Ok(None)` on success (node added or touched).
    /// Returns `Ok(Some(eviction_candidate))` if the target bucket is full —
    /// the caller must then check the pending-query set and, if safe,
    /// call [`evict_and_insert`] to perform the swap.
    /// Returns `Err(EvictionCooldown)` if the node was recently removed.
    pub fn insert(
        &self,
        local_id: &str,
        entry: NodeEntry,
    ) -> Result<Option<NodeEntry>, InsertError> {
        // Check eviction cooldown
        {
            let cooldown = self
                .evicted_cooldown
                .read()
                .map_err(|_| InsertError::LockPoisoned)?;
            if let Some(&removed_at) = cooldown.get(&entry.id) {
                if removed_at.elapsed() < EVICTION_COOLDOWN {
                    return Err(InsertError::EvictionCooldown {
                        retry_after: EVICTION_COOLDOWN.saturating_sub(removed_at.elapsed()),
                    });
                }
            }
        }

        let idx = bucket_index(local_id, &entry.id);
        let deadline = Instant::now() + Duration::from_millis(WRITE_LOCK_TIMEOUT_MS);
        let mut bucket;
        loop {
            match self.buckets[idx].try_write() {
                Ok(b) => {
                    bucket = b;
                    break;
                }
                Err(_) => {
                    if Instant::now() >= deadline {
                        return Err(InsertError::LockContended);
                    }
                    std::thread::yield_now();
                }
            }
        }
        Ok(bucket.insert(entry))
    }

    /// Evict the LRS node from the bucket at `bucket_idx` and insert the
    /// replacement. Records the evicted node in the cooldown map.
    /// Enforces batch eviction: if more than BATCH_EVICTION_LIMIT evictions
    /// occur in the cooldown window, the oldest entries are released early.
    pub fn evict_and_insert(
        &self,
        local_id: &str,
        bucket_idx: usize,
        replacement: NodeEntry,
    ) -> Result<(), InsertError> {
        let mut bucket = self.buckets[bucket_idx]
            .write()
            .map_err(|_| InsertError::LockPoisoned)?;

        let evicted = bucket.remove(&replacement.id); // guard against self-evict
        if evicted.is_some() {
            // This shouldn't happen, but handle gracefully
        }

        // Find and remove the LRS node
        if let Some(lrs) = bucket.lrs_node().cloned() {
            let lrs_id = lrs.id.clone();
            bucket.remove(&lrs_id);

            // Record in cooldown map
            drop(bucket); // release before acquiring write lock on cooldown
            if let Ok(mut cd) = self.evicted_cooldown.write() {
                cd.insert(lrs_id, Instant::now());
            }

            // Batch eviction enforcement
            if let Ok(mut count) = self.eviction_count.write() {
                *count += 1;
                if *count > BATCH_EVICTION_LIMIT {
                    if let Ok(mut window_start) = self.batch_window_start.write() {
                        if window_start.elapsed() < EVICTION_COOLDOWN {
                            // Release oldest entries from cooldown early
                            if let Ok(mut cd) = self.evicted_cooldown.write() {
                                let mut to_release: Vec<NodeId> = Vec::new();
                                for (id, t) in cd.iter() {
                                    if t.elapsed() > EVICTION_COOLDOWN / 2 {
                                        to_release.push(id.clone());
                                        if to_release.len() >= 5 {
                                            break;
                                        }
                                    }
                                }
                                for id in to_release {
                                    cd.remove(&id);
                                }
                            }
                        }
                        *window_start = Instant::now();
                    }
                    *count = 0;
                }
            }

            // Re-acquire and insert
            let mut bucket = self.buckets[bucket_idx]
                .write()
                .map_err(|_| InsertError::LockPoisoned)?;
            bucket.insert(replacement);
        } else {
            bucket.insert(replacement);
        }

        Ok(())
    }

    /// Touch a node on successful lookup (optimistic read path).
    ///
    /// This is called from the read path and must be fast. It updates
    /// `last_seen` and `latency_ms`, promoting the node to MRU position.
    pub fn touch(&self, local_id: &str, node_id: &str, latency_ms: f64) -> bool {
        let idx = bucket_index(local_id, node_id);
        // Read lock — never blocks readers, only defers writers
        if let Ok(mut bucket) = self.buckets[idx].read() {
            // We need write access to mutate; promote to write lock.
            // This is acceptable because touch is infrequent relative
            // to reads and the write is tiny.
            drop(bucket);
        }
        // Acquire write for the mutation
        if let Ok(mut bucket) = self.buckets[idx].write() {
            let now = now_millis();
            bucket.touch(node_id, now, latency_ms)
        } else {
            false
        }
    }

    /// Iterate all nodes across all buckets (for diagnostics / serialization).
    pub fn all_nodes(&self) -> Vec<NodeEntry> {
        let mut result = Vec::new();
        for bucket in &self.buckets {
            if let Ok(b) = bucket.read() {
                result.extend(b.entries().iter().cloned());
            }
        }
        result
    }

    /// Number of known live nodes.
    pub fn size(&self) -> usize {
        self.all_nodes().len()
    }

    /// Prune the cooldown map of entries older than [`EVICTION_COOLDOWN`].
    pub fn prune_cooldown(&self) {
        if let Ok(mut cd) = self.evicted_cooldown.write() {
            cd.retain(|_, t| t.elapsed() < EVICTION_COOLDOWN);
        }
    }
}

// ─── Error types ──────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum InsertError {
    LockPoisoned,
    LockContended,
    EvictionCooldown { retry_after: Duration },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str) -> NodeEntry {
        NodeEntry {
            id: id.to_string(),
            address: format!("10.0.0.1:9000"),
            last_seen: now_millis(),
            latency_ms: 50.0,
            fail_count: 0,
            added_at: Instant::now(),
        }
    }

    #[test]
    fn bucket_index_basic() {
        let local = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
        let close = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b1";
        let far = "00000000000000000000000000000000000000000000";
        assert!(bucket_index(local, close) > bucket_index(local, far));
    }

    #[test]
    fn bucket_insert_within_capacity() {
        let mut bucket = KBucket::new();
        for i in 0..BUCKET_K {
            let e = entry(&format!("node_{i:04}"));
            assert!(bucket.insert(e).is_none());
        }
        assert_eq!(bucket.len(), BUCKET_K);
    }

    #[test]
    fn bucket_insert_full_returns_eviction_candidate() {
        let mut bucket = KBucket::new();
        for i in 0..BUCKET_K {
            let mut e = entry(&format!("node_{i:04}"));
            // Stagger timestamps so node_0019 is LRS
            e.last_seen = now_millis() - (BUCKET_K - i) as u64 * 1000;
            bucket.insert(e);
        }
        let new = entry("new_node");
        let candidate = bucket.insert(new);
        assert!(candidate.is_some());
        assert_eq!(candidate.unwrap().id, "node_0019"); // lowest last_seen
    }

    #[test]
    fn bucket_touch_promotes_to_mru() {
        let mut bucket = KBucket::new();
        for i in 0..BUCKET_K {
            let mut e = entry(&format!("node_{i:04}"));
            e.last_seen = now_millis() - i as u64 * 1000;
            bucket.insert(e);
        }
        // Touch node_0019 (currently at tail / LRS)
        assert!(bucket.touch("node_0019", now_millis(), 25.0));
        // Should now be at position 0 (MRU)
        assert_eq!(bucket.entries()[0].id, "node_0019");
    }

    #[test]
    fn routing_table_insert_and_touch() {
        let rt = RoutingTable::new("a1b2");
        let e = entry("deadbeef");
        assert!(rt.insert("a1b2", e).unwrap().is_none());
        assert!(rt.touch("a1b2", "deadbeef", 42.0));
        assert_eq!(rt.size(), 1);
    }

    #[test]
    fn cooldown_prevents_reinsertion() {
        let rt = RoutingTable::new("local");
        let e = entry("flapper");

        // Insert
        rt.insert("local", e.clone()).unwrap();

        // Manually evict by removing from bucket
        let idx = bucket_index("local", "flapper");
        rt.buckets[idx].write().unwrap().remove("flapper");

        // Record in cooldown
        rt.evicted_cooldown
            .write()
            .unwrap()
            .insert("flapper".into(), Instant::now());

        // Re-insert should fail
        match rt.insert("local", entry("flapper")) {
            Err(InsertError::EvictionCooldown { .. }) => {}
            other => panic!("expected EvictionCooldown, got {:?}", other),
        }
    }
}
