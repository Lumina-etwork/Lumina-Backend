import { CircuitBreakerStateMachine } from "../state-machine"

describe("CircuitBreakerStateMachine", () => {
  let stateChanges: Array<{ from: string; to: string }> = []

  beforeEach(() => {
    stateChanges = []
  })

  function createBreaker(opts = {}) {
    return new CircuitBreakerStateMachine({
      upstreamUrl: "https://test-upstream.local",
      backoffBaseMs: 100,
      backoffMaxMs: 500,
      failureThreshold: 3,
      failureWindowMs: 10_000,
      cooldownExtensionMs: 300,
      onStateChange: (_url, from, to) => stateChanges.push({ from, to }),
      ...opts,
    })
  }

  it("starts in CLOSED state", () => {
    const cb = createBreaker()
    expect(cb.getState()).toBe("CLOSED")
  })

  it("trips to OPEN after failure threshold", () => {
    const cb = createBreaker()
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.getState()).toBe("CLOSED")
    cb.recordFailure()
    expect(cb.getState()).toBe("OPEN")
    expect(stateChanges).toEqual([{ from: "CLOSED", to: "OPEN" }])
  })

  it("stays OPEN during backoff", () => {
    const cb = createBreaker()
    for (let i = 0; i < 3; i++) cb.recordFailure()
    expect(cb.getState()).toBe("OPEN")
    expect(cb.getState()).toBe("OPEN")
  })

  it("transitions to HALF_OPEN after backoff expires", async () => {
    const cb = createBreaker()
    for (let i = 0; i < 3; i++) cb.recordFailure()
    expect(cb.getState()).toBe("OPEN")
    await new Promise((r) => setTimeout(r, 300))
    expect(cb.getState()).toBe("HALF_OPEN")
  })

  it("returns to CLOSED on success in HALF_OPEN", async () => {
    const cb = createBreaker()
    for (let i = 0; i < 3; i++) cb.recordFailure()
    await new Promise((r) => setTimeout(r, 300))
    expect(cb.getState()).toBe("HALF_OPEN")
    cb.recordSuccess()
    expect(cb.getState()).toBe("CLOSED")
  })

  it("extends cooldown on timeout failure in HALF_OPEN", async () => {
    const cb = createBreaker()
    for (let i = 0; i < 3; i++) cb.recordFailure()
    await new Promise((r) => setTimeout(r, 300))
    expect(cb.getState()).toBe("HALF_OPEN")
    cb.recordFailure(true)
    expect(cb.getState()).toBe("OPEN")
    expect(cb.getState()).toBe("OPEN")
  })

  it("resets correctly", () => {
    const cb = createBreaker()
    for (let i = 0; i < 3; i++) cb.recordFailure()
    expect(cb.getState()).toBe("OPEN")
    cb.reset()
    expect(cb.getState()).toBe("CLOSED")
  })

  it("rejects execute() when OPEN", async () => {
    const cb = createBreaker()
    for (let i = 0; i < 3; i++) cb.recordFailure()
    await expect(cb.execute(async () => "ok")).rejects.toThrow("Circuit breaker is OPEN")
  })

  it("allows execute() in CLOSED state", async () => {
    const cb = createBreaker()
    const result = await cb.execute(async () => "hello")
    expect(result).toBe("hello")
  })
})
