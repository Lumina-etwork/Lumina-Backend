import { BackoffCalculator } from "../backoff-calculator"

describe("BackoffCalculator", () => {
  const calc = new BackoffCalculator(1000, 10_000)

  it("returns a value >= baseDelay for attempt 0", () => {
    const delay = calc.getDelay(0)
    expect(delay).toBeGreaterThanOrEqual(1000)
  })

  it("increases average delay with higher attempts", () => {
    const samples0 = Array.from({ length: 50 }, () => calc.getDelay(0))
    const samples3 = Array.from({ length: 50 }, () => calc.getDelay(3))
    const avg0 = samples0.reduce((a, b) => a + b, 0) / samples0.length
    const avg3 = samples3.reduce((a, b) => a + b, 0) / samples3.length
    expect(avg3).toBeGreaterThan(avg0)
  })

  it("never exceeds max", () => {
    for (let i = 0; i < 100; i++) {
      expect(calc.getDelay(20)).toBeLessThanOrEqual(10_000)
    }
  })

  it("includes jitter (non-deterministic)", () => {
    const delays = new Set(Array.from({ length: 20 }, () => calc.getDelay(2)))
    expect(delays.size).toBeGreaterThan(1)
  })
})
