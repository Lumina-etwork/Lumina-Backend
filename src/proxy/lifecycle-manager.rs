use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::proxy::graceful_shutdown::{GracefulShutdown, ShutdownPhase};
use crate::proxy::flow_table::FlowTable;

/// Lifecycle manager — coordinates health checks, readiness probes, and
/// the shutdown sequence across the proxy subsystems.
///
/// The manager owns references to the graceful-shutdown orchestrator and
/// the flow table.  Health probes (liveness, readiness) query the manager
/// rather than reaching into sub-components directly, which keeps the
/// probe logic in one place and avoids coupling Kubernetes YAML to
/// internal module structure.
///
/// ## Health semantics
///
/// | Probe       | Meaning                                                   |
/// |-------------|-----------------------------------------------------------|
/// | **liveness**  | Process is alive and making progress.                    |
/// | **readiness** | Node can accept new traffic.                             |
///
/// During normal operation both return `true`.
/// During shutdown:
///   - liveness stays `true` until the shutdown sequence completes
///     (ShutdownPhase::Stopped), so the kubelet doesn't kill the pod
///     while it's still draining.
///   - readiness flips to `false` immediately when the shutdown signal
///     is received, so the Service endpoint controller removes the pod
///     from the load-balancer pool.
///
/// ## Grace period
///
/// After a rolling restart, the node starts with a grace period
/// (default 15s) during which readiness is forced `false` to allow
/// caches and flow tables to warm up.  The readiness probe returns
/// `false` during this window even though the node is not shutting down.

const DEFAULT_GRACE_PERIOD_S: u64 = 15;

/// Configuration for the lifecycle manager.
#[derive(Debug, Clone)]
pub struct LifecycleConfig {
    /// How long to wait after startup before declaring readiness.
    pub grace_period_s: u64,
}

impl Default for LifecycleConfig {
    fn default() -> Self {
        Self {
            grace_period_s: DEFAULT_GRACE_PERIOD_S,
        }
    }
}

/// Health status returned to probes.
#[derive(Debug, Clone, serde::Serialize)]
pub struct HealthStatus {
    /// Is the process alive and making progress?
    pub alive: bool,
    /// Can this node accept new traffic?
    pub ready: bool,
    /// Human-readable reason when not ready.
    pub reason: Option<String>,
    /// Current shutdown phase.
    pub phase: &'static str,
    /// Number of active flows in the flow table.
    pub active_flows: u64,
    /// Uptime in seconds.
    pub uptime_s: u64,
}

/// The lifecycle manager itself.
pub struct LifecycleManager {
    config: LifecycleConfig,
    shutdown: Arc<GracefulShutdown>,
    flow_table: Arc<parking_lot::Mutex<FlowTable>>,
    /// Timestamp when the process started.
    started_at: Instant,
    /// Whether the grace period has elapsed (set once, never cleared).
    grace_period_elapsed: AtomicBool,
}

impl LifecycleManager {
    pub fn new(
        config: LifecycleConfig,
        shutdown: Arc<GracefulShutdown>,
        flow_table: Arc<parking_lot::Mutex<FlowTable>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            config,
            shutdown,
            flow_table,
            started_at: Instant::now(),
            grace_period_elapsed: AtomicBool::new(false),
        })
    }

    // ── Liveness ──────────────────────────────────────────────────

    /// Liveness probe: returns `true` until the shutdown sequence is fully
    /// complete (Stopped phase).  During Draining/Forcing the process is
    /// still alive — it's just winding down.
    pub fn is_alive(&self) -> bool {
        !self.shutdown.is_stopped()
    }

    // ── Readiness ─────────────────────────────────────────────────

    /// Readiness probe: returns `true` only when:
    ///  1. The grace period has elapsed, AND
    ///  2. The node is NOT in any shutdown phase.
    pub fn is_ready(&self) -> bool {
        self.check_grace_period();
        if !self.grace_period_elapsed.load(Ordering::Relaxed) {
            return false;
        }
        self.shutdown.current_phase() == ShutdownPhase::Running
    }

    /// Returns a structured health status for both HTTP handlers and logging.
    pub fn health_status(&self) -> HealthStatus {
        self.check_grace_period();
        let phase = self.shutdown.current_phase();
        let uptime = self.started_at.elapsed();
        let active_flows = {
            let ft = self.flow_table.lock();
            ft.flow_count.load(Ordering::Relaxed)
        };

        let alive = !self.shutdown.is_stopped();
        let grace_ok = self.grace_period_elapsed.load(Ordering::Relaxed);
        let ready = grace_ok && phase == ShutdownPhase::Running;

        let reason = if !grace_ok {
            Some("grace period not yet elapsed".to_string())
        } else if phase != ShutdownPhase::Running {
            Some(format!("shutting down: {:?}", phase))
        } else {
            None
        };

        HealthStatus {
            alive,
            ready,
            reason,
            phase: match phase {
                ShutdownPhase::Running => "running",
                ShutdownPhase::Draining => "draining",
                ShutdownPhase::Forcing => "forcing",
                ShutdownPhase::Stopped => "stopped",
            },
            active_flows,
            uptime_s: uptime.as_secs(),
        }
    }

    // ── Shutdown coordination ─────────────────────────────────────

    /// Initiate the shutdown sequence.  This is the single entry-point that
    /// kubelet / process supervisor / signal handler should call.
    ///
    /// The method is idempotent — calling it multiple times is safe and has
    /// no additional effect beyond the first call.
    pub fn initiate_shutdown(&self) {
        self.shutdown.signal();
        eprintln!(
            "[lifecycle-manager] shutdown initiated — readiness set to false, liveness stays true until drain completes"
        );
    }

    /// Returns the remaining drain budget (time left before forced stop).
    /// Useful for logging progress in a background ticker.
    pub fn remaining_drain_budget(&self) -> Duration {
        self.shutdown.remaining_in_phase()
    }

    /// Returns true if the shutdown sequence has completed (all phases done).
    pub fn is_fully_stopped(&self) -> bool {
        self.shutdown.is_stopped()
    }

    // ── Private ───────────────────────────────────────────────────

    /// Check whether the grace period has elapsed and flip the flag if so.
    /// Uses Relaxed ordering — it's fine if a few probes read a stale value.
    fn check_grace_period(&self) {
        if self.grace_period_elapsed.load(Ordering::Relaxed) {
            return;
        }
        if self.started_at.elapsed() >= Duration::from_secs(self.config.grace_period_s) {
            self.grace_period_elapsed.store(true, Ordering::Relaxed);
            eprintln!(
                "[lifecycle-manager] grace period elapsed — node is now ready"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::graceful_shutdown::ShutdownConfig;

    fn make_manager(grace_period: u64) -> Arc<LifecycleManager> {
        let shutdown = GracefulShutdown::new(ShutdownConfig::default());
        let flow_table = Arc::new(parking_lot::Mutex::new(FlowTable::new()));
        LifecycleManager::new(
            LifecycleConfig { grace_period_s: grace_period },
            shutdown,
            flow_table,
        )
    }

    #[test]
    fn alive_before_shutdown() {
        let lm = make_manager(0);
        assert!(lm.is_alive());
    }

    #[test]
    fn not_ready_during_grace_period() {
        let lm = make_manager(9999); // very long grace period
        assert!(!lm.is_ready());
    }

    #[test]
    fn ready_after_grace_period() {
        let lm = make_manager(0); // zero grace period → immediate ready
        assert!(lm.is_ready());
    }

    #[test]
    fn not_ready_after_shutdown_signal() {
        let lm = make_manager(0);
        assert!(lm.is_ready());
        lm.initiate_shutdown();
        assert!(!lm.is_ready());
    }

    #[test]
    fn still_alive_during_drain() {
        let lm = make_manager(0);
        lm.initiate_shutdown();
        // During draining, liveness is still true.
        assert!(lm.is_alive());
    }

    #[test]
    fn health_status_fields() {
        let lm = make_manager(0);
        let h = lm.health_status();
        assert!(h.alive);
        assert!(h.ready);
        assert!(h.reason.is_none());
        assert_eq!(h.phase, "running");
    }

    #[test]
    fn health_status_shows_shutdown_phase() {
        let lm = make_manager(0);
        lm.initiate_shutdown();
        let h = lm.health_status();
        assert!(h.alive);
        assert!(!h.ready);
        assert!(h.reason.is_some());
    }

    #[test]
    fn initiate_shutdown_is_idempotent() {
        let lm = make_manager(0);
        lm.initiate_shutdown();
        lm.initiate_shutdown(); // should not panic
        assert!(!lm.is_ready());
    }
}
