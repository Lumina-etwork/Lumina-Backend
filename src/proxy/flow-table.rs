use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Per-flow tracking table.
///
/// Each entry represents a proxied flow (client → upstream).  When the proxy-side
/// socket closes, the entry must be evicted so it does not become a zombie:
/// a ghost entry whose proxy-side socket is gone but the flow-table still holds
/// the client+upstream state, preventing cleanup.
///
/// Two safety nets ensure zero zombie accumulation:
///
/// 1. **Socket-close callback** (immediate): when the proxy-side socket emits
///    `close` / `error`, the caller invokes `on_socket_close()` to remove the
///    entry instantly.
///
/// 2. **Stale-entry TTL** (periodic): any entry with no traffic for 60s is
///    force-evicted and logged as a potential zombie.  This catches cases where
///    the close callback was missed (e.g. crash or OOM during dispatch).
///
/// Additionally, during phase 2 of shutdown the drainer can call
/// `evict_all_without_proxy_socket()` to sweep remaining entries whose proxy
/// socket has already been destroyed.

const STALE_TTL_SECS: u64 = 60;

#[derive(Debug, Clone)]
pub struct FlowEntry {
    /// Stable identifier for the flow (e.g. `<client_addr>:<upstream_addr>:<stream_id>`).
    pub flow_id: String,
    /// Client socket reference (upstream may be unavailable).
    pub client_addr: String,
    /// Upstream socket reference.
    pub upstream_addr: String,
    /// When this entry was created.
    pub created_at: Instant,
    /// Last time any traffic was observed on this flow.
    pub last_activity: Instant,
    /// Whether the proxy-side socket is still open.
    pub proxy_socket_alive: bool,
}

#[derive(Debug, Default)]
pub struct FlowTableMetrics {
    /// Total entries in the table.
    pub active_flows: u64,
    /// Entries evicted via stale TTL.
    pub stale_evictions: u64,
    /// Entries evicted via socket-close callback.
    pub close_evictions: u64,
    /// Entries evicted during force-close sweep.
    pub force_evictions: u64,
}

pub struct FlowTable {
    flows: HashMap<String, FlowEntry>,
    /// Stale-entry TTL (configurable for testing).
    stale_ttl: Duration,
    /// Whether the table has been initialized (false means empty/no flows yet).
    pub initialized: AtomicBool,
    /// Total flow count for quick reads without locking.
    pub flow_count: AtomicU64,
}

impl FlowTable {
    pub fn new() -> Self {
        Self {
            flows: HashMap::new(),
            stale_ttl: Duration::from_secs(STALE_TTL_SECS),
            initialized: AtomicBool::new(false),
            flow_count: AtomicU64::new(0),
        }
    }

    /// Create with a custom stale TTL (for tests).
    pub fn with_stale_ttl(ttl: Duration) -> Self {
        Self {
            flows: HashMap::new(),
            stale_ttl: ttl,
            initialized: AtomicBool::new(false),
            flow_count: AtomicU64::new(0),
        }
    }

    // ── CRUD ─────────────────────────────────────────────────────────

    /// Register a new flow.  Called when the proxy forwards a connection.
    pub fn insert(&mut self, entry: FlowEntry) {
        let id = entry.flow_id.clone();
        self.initialized.store(true, Ordering::SeqCst);
        self.flows.insert(id, entry);
        self.flow_count.store(self.flows.len() as u64, Ordering::SeqCst);
    }

    /// Mark a flow as having recent traffic (called from the data-forwarding path).
    pub fn touch(&mut self, flow_id: &str) {
        if let Some(entry) = self.flows.get_mut(flow_id) {
            entry.last_activity = Instant::now();
        }
    }

    /// **Socket-close callback** — called when the proxy-side socket closes.
    /// Evicts the flow entry immediately so it cannot become a zombie.
    pub fn on_socket_close(&mut self, flow_id: &str) -> bool {
        let removed = self.flows.remove(flow_id).is_some();
        if removed {
            self.flow_count.store(self.flows.len() as u64, Ordering::SeqCst);
        }
        removed
    }

    // ── Periodic sweep ───────────────────────────────────────────────

    /// Scan for stale entries (no traffic for > stale_ttl) and evict them.
    /// Returns the list of evicted flow IDs for logging / metrics.
    pub fn evict_stale(&mut self) -> Vec<String> {
        let now = Instant::now();
        let stale_ids: Vec<String> = self
            .flows
            .iter()
            .filter(|(_, entry)| now.duration_since(entry.last_activity) > self.stale_ttl)
            .map(|(id, _)| id.clone())
            .collect();

        for id in &stale_ids {
            self.flows.remove(id);
        }

        if !stale_ids.is_empty() {
            self.flow_count.store(self.flows.len() as u64, Ordering::SeqCst);
        }

        stale_ids
    }

    // ── Phase 2 sweep ────────────────────────────────────────────────

    /// During phase 2 of shutdown, evict all entries whose proxy socket is closed.
    /// Returns evicted flow IDs.
    pub fn evict_orphans(&mut self) -> Vec<String> {
        let orphan_ids: Vec<String> = self
            .flows
            .iter()
            .filter(|(_, entry)| !entry.proxy_socket_alive)
            .map(|(id, _)| id.clone())
            .collect();

        for id in &orphan_ids {
            self.flows.remove(id);
        }

        if !orphan_ids.is_empty() {
            self.flow_count.store(self.flows.len() as u64, Ordering::SeqCst);
        }

        orphan_ids
    }

    /// Evict **everything** — called during final shutdown teardown.
    pub fn clear(&mut self) -> usize {
        let count = self.flows.len();
        self.flows.clear();
        self.flow_count.store(0, Ordering::SeqCst);
        count
    }

    // ── Metrics ──────────────────────────────────────────────────────

    pub fn metrics(&self) -> FlowTableMetrics {
        FlowTableMetrics {
            active_flows: self.flows.len() as u64,
            stale_evictions: 0,   // tracked externally via evict_stale() return
            close_evictions: 0,   // tracked externally via on_socket_close() return
            force_evictions: 0,   // tracked externally via evict_orphans() return
        }
    }

    pub fn len(&self) -> usize {
        self.flows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.flows.is_empty()
    }

    pub fn get(&self, flow_id: &str) -> Option<&FlowEntry> {
        self.flows.get(flow_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_entry(id: &str) -> FlowEntry {
        let now = Instant::now();
        FlowEntry {
            flow_id: id.to_string(),
            client_addr: "127.0.0.1:8080".to_string(),
            upstream_addr: "10.0.0.1:3000".to_string(),
            created_at: now,
            last_activity: now,
            proxy_socket_alive: true,
        }
    }

    #[test]
    fn insert_and_len() {
        let mut ft = FlowTable::new();
        ft.insert(make_entry("f1"));
        ft.insert(make_entry("f2"));
        assert_eq!(ft.len(), 2);
        assert!(ft.initialized.load(Ordering::SeqCst));
    }

    #[test]
    fn on_socket_close_evicts() {
        let mut ft = FlowTable::new();
        ft.insert(make_entry("f1"));
        assert!(ft.on_socket_close("f1"));
        assert!(ft.is_empty());
    }

    #[test]
    fn touch_updates_last_activity() {
        let mut ft = FlowTable::with_stale_ttl(Duration::from_millis(50));
        ft.insert(make_entry("f1"));

        // Touch to refresh
        ft.touch("f1");

        // After 20ms it should still be alive
        std::thread::sleep(Duration::from_millis(20));
        let evicted = ft.evict_stale();
        assert!(evicted.is_empty(), "should not evict after touch");

        // After 60ms total (well past 50ms TTL) it should be evicted
        std::thread::sleep(Duration::from_millis(40));
        let evicted = ft.evict_stale();
        assert_eq!(evicted, vec!["f1".to_string()]);
    }

    #[test]
    fn evict_orphans() {
        let mut ft = FlowTable::new();
        ft.insert(make_entry("alive"));
        let mut dead = make_entry("dead");
        dead.proxy_socket_alive = false;
        ft.insert(dead);

        let orphans = ft.evict_orphans();
        assert_eq!(orphans, vec!["dead".to_string()]);
        assert_eq!(ft.len(), 1);
    }

    #[test]
    fn clear_removes_all() {
        let mut ft = FlowTable::new();
        ft.insert(make_entry("f1"));
        ft.insert(make_entry("f2"));
        ft.insert(make_entry("f3"));
        let removed = ft.clear();
        assert_eq!(removed, 3);
        assert!(ft.is_empty());
    }
}
