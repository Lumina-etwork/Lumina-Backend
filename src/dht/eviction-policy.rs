//! Least-recently-responded (LRR) eviction policy.
//!
//! Decides which node to evict from a full k-bucket when a new candidate
//! arrives. Integrates with:
//!
//! - **pending-query set** (maintained in `node-lookup.ts`) — a node
//!   currently being queried must *never* be evicted.
//! - **batch window** — at most 5 evictions per 10 s window per bucket.
//! - **cooldown** — nodes evicted within the last 300 s are skipped.
//!
//! This file is consumed from TypeScript via the same integration point
//! as `routing-table.rs` (NAPI binding or FFI call). The pure-Rust
//! logic here is intentionally side-effect free so it can be unit-tested
//! in isolation.

use std::collections::HashSet;
use std::time::{Duration, Instant};

/// Maximum evictions allowed per batch window per bucket.
pub const MAX_EVICTIONS_PER_WINDOW: usize = 5;

/// Duration of the batch eviction window.
pub const BATCH_WINDOW: Duration = Duration::from_secs(10);

/// Cooldown before a removed node can be re-added (mirrors routing-table).
pub const EVICTION_COOLDOWN: Duration = Duration::from_secs(300);

/// Minimal candidate view used by the eviction policy.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub id: String,
    /// Unix-millis timestamp of the last successful response.
    pub last_seen: u64,
    /// Consecutive failed RPCs.
    pub fail_count: u32,
}

/// Select the best eviction candidate from the given `candidates` slice.
///
/// Walks from the tail (least-recently-seen) upward, skipping nodes that
/// are in the `pending` set (currently being queried), the `recently_evicted`
/// set (cooldown), or have zero failures.
///
/// Returns `Some(index)` into `candidates` if a safe target exists, `None`
/// if all candidates are protected.
pub fn select_eviction_candidate(
    candidates: &[Candidate],
    pending: &HashSet<String>,
    recently_evicted: &HashSet<String>,
) -> Option<usize> {
    candidates
        .iter()
        .enumerate()
        .rev()
        .find(|(_, c)| {
            !pending.contains(&c.id)
                && !recently_evicted.contains(&c.id)
                && c.fail_count > 0
        })
        .map(|(i, _)| i)
}

/// Check whether an eviction should be batched (not exceed the per-window
/// limit). If the window has elapsed, the counter resets implicitly.
pub fn can_evict_in_batch(evictions_this_window: usize, window_start: Instant) -> bool {
    evictions_this_window < MAX_EVICTIONS_PER_WINDOW || window_start.elapsed() >= BATCH_WINDOW
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(id: &str, last_seen: u64, fail_count: u32) -> Candidate {
        Candidate {
            id: id.to_string(),
            last_seen,
            fail_count,
        }
    }

    #[test]
    fn skips_pending_nodes() {
        // a is LRS (lower last_seen) but pending, so b should be selected
        let candidates = vec![cand("a", 100, 1), cand("b", 200, 2)];
        let mut pending = HashSet::new();
        pending.insert("a".into());
        let evicted = HashSet::new();

        let idx = select_eviction_candidate(&candidates, &pending, &evicted);
        assert!(idx.is_some());
        // Walks from tail: b (fail=2, not pending) → selected
        assert_eq!(candidates[idx.unwrap()].id, "b");
    }

    #[test]
    fn skips_recently_evicted() {
        let candidates = vec![cand("a", 100, 1)];
        let pending = HashSet::new();
        let mut recent = HashSet::new();
        recent.insert("a".into());
        assert!(select_eviction_candidate(&candidates, &pending, &recent).is_none());
    }

    #[test]
    fn skips_zero_fail_count() {
        let candidates = vec![cand("a", 100, 0)];
        let pending = HashSet::new();
        let evicted = HashSet::new();
        assert!(select_eviction_candidate(&candidates, &pending, &evicted).is_none());
    }

    #[test]
    fn selects_lrs_with_failures() {
        let candidates = vec![
            cand("a", 500, 0), // MRU but no failures
            cand("b", 300, 3), // older, 3 failures
            cand("c", 100, 1), // LRS, 1 failure
        ];
        let pending = HashSet::new();
        let evicted = HashSet::new();
        let idx = select_eviction_candidate(&candidates, &pending, &evicted);
        assert_eq!(candidates[idx.unwrap()].id, "c");
    }

    #[test]
    fn batch_window_limit() {
        assert!(can_evict_in_batch(4, Instant::now()));
        assert!(!can_evict_in_batch(5, Instant::now()));
        let old = Instant::now() - BATCH_WINDOW - Duration::from_secs(1);
        assert!(can_evict_in_batch(100, old));
    }
}
