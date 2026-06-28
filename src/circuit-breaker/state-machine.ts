import { BackoffCalculator } from "./backoff-calculator"
import { FailureSlidingWindow } from "./failure-sliding-window"
import { ProbeExecutor } from "./probe-executor"
import { UpstreamHealthCache, type HealthRecord } from "./upstream-health-cache"

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN"

export interface CircuitBreakerOptions {
  upstreamUrl: string
  backoffBaseMs?: number
  backoffMaxMs?: number
  failureThreshold?: number
  failureWindowMs?: number
  probeTimeoutMs?: number
  cooldownExtensionMs?: number
  onStateChange?: (upstream: string, from: CircuitState, to: CircuitState) => void
}

export class CircuitBreakerStateMachine {
  private state: CircuitState = "CLOSED"
  private readonly backoff: BackoffCalculator
  private readonly window: FailureSlidingWindow
  private readonly probeExecutor: ProbeExecutor
  private readonly healthCache: UpstreamHealthCache
  private readonly options: Required<CircuitBreakerOptions>

  private openSince: number | null = null
  private backoffAttempt = 0
  private cooldownUntil: number | null = null

  constructor(options: CircuitBreakerOptions) {
    this.options = {
      backoffBaseMs: 5_000,
      backoffMaxMs: 60_000,
      failureThreshold: 5,
      failureWindowMs: 60_000,
      probeTimeoutMs: 2_000,
      cooldownExtensionMs: 30_000,
      onStateChange: options.onStateChange ?? (() => {}),
      ...options,
    }

    this.backoff = new BackoffCalculator(
      this.options.backoffBaseMs,
      this.options.backoffMaxMs,
    )
    this.window = new FailureSlidingWindow(
      this.options.failureThreshold,
      this.options.failureWindowMs,
    )
    this.probeExecutor = new ProbeExecutor(this.options.probeTimeoutMs)
    this.healthCache = new UpstreamHealthCache()
  }

  getState(): CircuitState {
    this.checkTransitions()
    return this.state
  }

  getHealthRecord(): HealthRecord | undefined {
    return this.healthCache.get(this.options.upstreamUrl)
  }

  setMaintenanceWindow(window: { startHour: number; endHour: number; timezone: string }): void {
    this.healthCache.setMaintenanceWindow(this.options.upstreamUrl, window)
  }

  recordFailure(isTimeout = false): void {
    const count = this.window.record()

    if (this.state === "CLOSED" && count >= this.options.failureThreshold) {
      this.transition("OPEN")
      this.openSince = Date.now()
      this.backoffAttempt = 0
    }

    if (this.state === "HALF_OPEN" && isTimeout) {
      this.cooldownUntil = Date.now() + this.options.cooldownExtensionMs
      this.transition("OPEN")
      this.openSince = Date.now()
    }
  }

  recordSuccess(): void {
    this.window.reset()
    if (this.state === "HALF_OPEN") {
      this.transition("CLOSED")
      this.openSince = null
      this.cooldownUntil = null
      this.backoffAttempt = 0
    }
  }

  async execute<T>(request: () => Promise<T>): Promise<T> {
    this.checkTransitions()

    if (this.state === "OPEN") {
      throw new Error(
        "Circuit breaker is OPEN for " + this.options.upstreamUrl,
      )
    }

    if (this.state === "HALF_OPEN") {
      const probeOk = await this.probeExecutor.probe(this.options.upstreamUrl)
      if (!probeOk) {
        this.recordFailure(true)
        throw new Error("Circuit breaker half-open probe failed")
      }
    }

    try {
      const result = await request()
      this.recordSuccess()
      return result
    } catch (err) {
      const isTimeout = err instanceof Error && /timeout|abort/i.test(err.message)
      this.recordFailure(isTimeout)
      throw err
    }
  }

  reset(): void {
    this.transition("CLOSED")
    this.window.reset()
    this.openSince = null
    this.cooldownUntil = null
    this.backoffAttempt = 0
  }

  private transition(newState: CircuitState): void {
    if (this.state === newState) return
    const prev = this.state
    this.state = newState
    this.options.onStateChange(this.options.upstreamUrl, prev, newState)
    if (typeof process !== 'undefined' && process.emit) {
      process.emit('metric', 'circuit_breaker_state_change', {
        upstream: this.options.upstreamUrl,
        from: prev,
        to: newState,
        timestamp: Date.now(),
      })
    }
  }

  private checkTransitions(): void {
    if (this.state !== "OPEN") return

    const now = Date.now()

    if (this.cooldownUntil !== null && now < this.cooldownUntil) {
      return
    }

    if (this.openSince !== null) {
      const backoffMs = this.backoff.getDelay(this.backoffAttempt)
      if (now - this.openSince >= backoffMs) {
        this.transition("HALF_OPEN")
      }
    }
  }
}
