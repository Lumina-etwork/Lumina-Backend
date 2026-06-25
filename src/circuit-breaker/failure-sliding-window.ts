export class FailureSlidingWindow {
  private failures: Array<{ timestamp: number }> = []
  private readonly threshold: number
  private readonly windowMs: number

  constructor(threshold = 5, windowMs = 60_000) {
    this.threshold = threshold
    this.windowMs = windowMs
  }

  record(): number {
    this.evict()
    this.failures.push({ timestamp: Date.now() })
    return this.failures.length
  }

  isTripped(): boolean {
    this.evict()
    return this.failures.length >= this.threshold
  }

  count(): number {
    this.evict()
    return this.failures.length
  }

  reset(): void {
    this.failures = []
  }

  private evict(): void {
    const cutoff = Date.now() - this.windowMs
    this.failures = this.failures.filter((f) => f.timestamp > cutoff)
  }
}
