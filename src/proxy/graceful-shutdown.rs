use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Two-phase graceful shutdown orchestrator.
///
/// Phase 1 (0..phase1_duration): stops accepting new connections, sends HTTP/2 GOAWAY
///   to every active upstream and downstream socket so peers migrate away.
/// Phase 2 (phase1_duration..total_timeout): sends TCP RST to remaining connections
///   so both sides tear down immediately instead of lingering in half-open state.
///
/// After phase 2, the `zombie_count` metric tells the operator how many flow-table
/// entries were force-evicted — the goal is zero.

const DEFAULT_DRAIN_TIMEOUT_S: u64 = 30;
const DEFAULT_PHASE1_DURATION_S: u64 = 25; // graceful drain window

/// Runtime-configurable knobs (env-var backed in production).
#[derive(Debug, Clone)]
pub struct ShutdownConfig {
    /// Total time budget for the entire shutdown sequence (seconds).
    pub drain_timeout_s: u64,
    /// How long phase 1 lasts (seconds). Must be < drain_timeout_s.
    pub phase1_duration_s: u64,
}

impl Default for ShutdownConfig {
    fn default() -> Self {
        Self {
            drain_timeout_s: DEFAULT_DRAIN_TIMEOUT_S,
            phase1_duration_s: DEFAULT_PHASE1_DURATION_S,
        }
    }
}

/// Metrics emitted during shutdown for observability.
#[derive(Debug, Default)]
pub struct ShutdownMetrics {
    /// Connections that completed graceful drain in phase 1.
    pub connections_drained: u64,
    /// Connections that were force-closed with RST in phase 2.
    pub connections_force_closed: u64,
    /// Zombie flow-table entries discovered post-shutdown (goal: 0).
    pub zombie_count: u64,
    /// Wall-clock drain duration from signal receipt to full stop.
    pub drain_duration: Option<Duration>,
}

/// Tracks the current phase of the shutdown sequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownPhase {
    /// Not shutting down — accepting connections normally.
    Running,
    /// Phase 1: stop accepting, send GOAWAY, drain gracefully.
    Draining,
    /// Phase 2: send RST to stragglers, force-close.
    Forcing,
    /// Shutdown complete.
    Stopped,
}

/// Core shutdown orchestrator.  Clone the `Arc<GracefulShutdown>` and hand it to
/// the proxy accept loop, connection-drainer, and lifecycle-manager.
pub struct GracefulShutdown {
    pub config: ShutdownConfig,

    /// Whether the shutdown signal has been received.
    pub signal_received: AtomicBool,
    /// Current phase (Running → Draining → Forcing → Stopped).
    /// Stored as u8 for atomicity; cast to ShutdownPhase at call-sites.
    phase: AtomicU64,
    /// Timestamp when shutdown signal was received.
    shutdown_start: parking_lot::Mutex<Option<Instant>>,
    /// Aggregated metrics.
    metrics: parking_lot::Mutex<ShutdownMetrics>,
}

impl GracefulShutdown {
    pub fn new(config: ShutdownConfig) -> Arc<Self> {
        Arc::new(Self {
            config,
            signal_received: AtomicBool::new(false),
            phase: AtomicU64::new(ShutdownPhase::Running as u64),
            shutdown_start: parking_lot::Mutex::new(None),
            metrics: parking_lot::Mutex::new(ShutdownMetrics::default()),
        })
    }

    /// Called when SIGTERM/SIGINT is received.  Transitions Running → Draining.
    pub fn signal(&self) {
        if self.signal_received.swap(true, Ordering::SeqCst) {
            return; // already signalled
        }
        *self.shutdown_start.lock() = Some(Instant::now());
        self.phase
            .store(ShutdownPhase::Draining as u64, Ordering::SeqCst);
        eprintln!("[graceful-shutdown] received signal — entering phase 1 (draining)");
    }

    /// Returns the current shutdown phase based on elapsed wall-clock time.
    pub fn current_phase(&self) -> ShutdownPhase {
        if !self.signal_received.load(Ordering::SeqCst) {
            return ShutdownPhase::Running;
        }

        let start = match *self.shutdown_start.lock() {
            Some(t) => t,
            None => return ShutdownPhase::Running,
        };

        let elapsed = start.elapsed();
        let phase1_end = Duration::from_secs(self.config.phase1_duration_s);
        let total = Duration::from_secs(self.config.drain_timeout_s);

        let phase = if elapsed < phase1_end {
            ShutdownPhase::Draining
        } else if elapsed < total {
            ShutdownPhase::Forcing
        } else {
            ShutdownPhase::Stopped
        };

        self.phase.store(phase as u64, Ordering::SeqCst);
        phase
    }

    /// Returns true when shutdown has fully completed (timeout expired).
    pub fn is_stopped(&self) -> bool {
        self.current_phase() == ShutdownPhase::Stopped
    }

    /// Returns `true` when we are in phase 1 (graceful drain window).
    pub fn is_draining(&self) -> bool {
        self.current_phase() == ShutdownPhase::Draining
    }

    /// Returns `true` when we are in phase 2 (force-close RST window).
    pub fn is_forcing(&self) -> bool {
        self.current_phase() == ShutdownPhase::Forcing
    }

    /// Remaining time in the current phase (useful for per-connection drain deadlines).
    pub fn remaining_in_phase(&self) -> Duration {
        let start = match *self.shutdown_start.lock() {
            Some(t) => t,
            None => return Duration::MAX,
        };

        let elapsed = start.elapsed();

        match self.current_phase() {
            ShutdownPhase::Draining => {
                let phase1_end = Duration::from_secs(self.config.phase1_duration_s);
                phase1_end.saturating_sub(elapsed)
            }
            ShutdownPhase::Forcing => {
                let total = Duration::from_secs(self.config.drain_timeout_s);
                total.saturating_sub(elapsed)
            }
            ShutdownPhase::Stopped => Duration::ZERO,
            ShutdownPhase::Running => Duration::MAX,
        }
    }

    // ── metrics ──────────────────────────────────────────────────────

    pub fn record_drained(&self, count: u64) {
        self.metrics.lock().connections_drained += count;
    }

    pub fn record_force_closed(&self, count: u64) {
        self.metrics.lock().connections_force_closed += count;
    }

    pub fn set_zombie_count(&self, count: u64) {
        self.metrics.lock().zombie_count = count;
    }

    pub fn finalize(&self) {
        let mut m = self.metrics.lock();
        if m.drain_duration.is_none() {
            if let Some(start) = *self.shutdown_start.lock() {
                m.drain_duration = Some(start.elapsed());
            }
        }
        self.phase
            .store(ShutdownPhase::Stopped as u64, Ordering::SeqCst);
    }

    pub fn snapshot_metrics(&self) -> ShutdownMetrics {
        let m = self.metrics.lock();
        ShutdownMetrics {
            connections_drained: m.connections_drained,
            connections_force_closed: m.connections_force_closed,
            zombie_count: m.zombie_count,
            drain_duration: m.drain_duration,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_in_running_phase() {
        let gs = GracefulShutdown::new(ShutdownConfig::default());
        assert_eq!(gs.current_phase(), ShutdownPhase::Running);
        assert!(!gs.signal_received.load(Ordering::SeqCst));
    }

    #[test]
    fn signal_transitions_to_draining() {
        let gs = GracefulShutdown::new(ShutdownConfig::default());
        gs.signal();
        assert!(gs.signal_received.load(Ordering::SeqCst));
        assert_eq!(gs.current_phase(), ShutdownPhase::Draining);
    }

    #[test]
    fn double_signal_is_idempotent() {
        let gs = GracefulShutdown::new(ShutdownConfig::default());
        gs.signal();
        gs.signal(); // should not panic or reset
        assert_eq!(gs.current_phase(), ShutdownPhase::Draining);
    }

    #[test]
    fn metrics_accumulate() {
        let gs = GracefulShutdown::new(ShutdownConfig::default());
        gs.record_drained(100);
        gs.record_force_closed(5);
        let m = gs.snapshot_metrics();
        assert_eq!(m.connections_drained, 100);
        assert_eq!(m.connections_force_closed, 5);
    }

    #[test]
    fn config_override() {
        let config = ShutdownConfig {
            drain_timeout_s: 60,
            phase1_duration_s: 50,
        };
        let gs = GracefulShutdown::new(config);
        assert_eq!(gs.config.drain_timeout_s, 60);
        assert_eq!(gs.config.phase1_duration_s, 50);
    }
}
