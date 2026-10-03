import { WebSocket } from 'ws';

/**
 * Reconnection strategies:
 * - 'full': delay = Uniform(0, min(maxDelay, base * multiplier^attempt))
 * - 'decorrelated': delay = min(maxDelay, Uniform(base, prevDelay * 3))
 */
export class JitterWebSocketClient {
  constructor({
    url,
    baseDelayMs = 50,
    maxDelayMs = 2000,
    multiplier = 2,
    maxRetries = 5,
    strategy = 'full',
    randomFn = Math.random,
  }) {
    this.url = url;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.multiplier = multiplier;
    this.maxRetries = maxRetries;
    this.strategy = strategy;
    this.random = randomFn;

    this.retryCount = 0;
    this.lastDelayMs = this.baseDelayMs;
    this.isManuallyClosed = false;
    this.ws = null;
    this.timer = null;

    // Test instrumentation hooks
    this.attemptLog = [];
    this.onReconnectScheduled = null;
    this.onMaxRetriesExceeded = null;
    this.onOpen = null;
  }

  computeDelay(attempt, previousDelay) {
    if (this.strategy === 'decorrelated') {
      const lower = this.baseDelayMs;
      const upper = Math.max(lower, previousDelay * 3);
      const raw = lower + this.random() * (upper - lower);
      return Math.floor(Math.min(this.maxDelayMs, raw));
    }

    // Default: Full Jitter
    const ceiling = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * Math.pow(this.multiplier, attempt),
    );
    return Math.floor(this.random() * ceiling);
  }

  connect() {
    if (this.isManuallyClosed) return;

    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.retryCount = 0;
      this.lastDelayMs = this.baseDelayMs;
      if (this.onOpen) this.onOpen();
    });

    this.ws.on('error', () => {
      // Ignored here; handled in close event
    });

    this.ws.on('close', () => {
      if (this.isManuallyClosed) return;
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.retryCount >= this.maxRetries) {
      if (this.onMaxRetriesExceeded) this.onMaxRetriesExceeded(this.retryCount);
      return;
    }

    const delay = this.computeDelay(this.retryCount, this.lastDelayMs);
    this.lastDelayMs = delay;

    this.attemptLog.push({
      attempt: this.retryCount + 1,
      delayMs: delay,
      scheduledAt: Date.now() + delay,
    });

    if (this.onReconnectScheduled) {
      this.onReconnectScheduled(this.retryCount + 1, delay);
    }

    this.retryCount += 1;
    this.timer = setTimeout(() => this.connect(), delay);
  }

  close() {
    this.isManuallyClosed = true;
    clearTimeout(this.timer);
    if (this.ws) {
      this.ws.terminate();
    }
  }
}
