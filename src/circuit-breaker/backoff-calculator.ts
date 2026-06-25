export class BackoffCalculator {
  private readonly baseMs: number
  private readonly maxMs: number

  constructor(baseMs = 5_000, maxMs = 60_000) {
    this.baseMs = baseMs
    this.maxMs = maxMs
  }

  getDelay(attempt: number): number {
    const exponential = this.baseMs * Math.pow(2, attempt)
    const jitter = Math.random() * this.baseMs * Math.pow(2, Math.max(0, attempt - 1))
    return Math.min(exponential + jitter, this.maxMs)
  }
}
