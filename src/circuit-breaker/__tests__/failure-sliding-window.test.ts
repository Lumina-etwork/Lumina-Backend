import { FailureSlidingWindow } from "../failure-sliding-window"

describe("FailureSlidingWindow", () => {
  it("starts at zero", () => {
    const w = new FailureSlidingWindow(5, 60_000)
    expect(w.count()).toBe(0)
    expect(w.isTripped()).toBe(false)
  })

  it("records failures and counts them", () => {
    const w = new FailureSlidingWindow(5, 60_000)
    w.record()
    w.record()
    expect(w.count()).toBe(2)
    expect(w.isTripped()).toBe(false)
  })

  it("trips when threshold is reached", () => {
    const w = new FailureSlidingWindow(3, 60_000)
    w.record()
    w.record()
    w.record()
    expect(w.isTripped()).toBe(true)
  })

  it("resets all failures", () => {
    const w = new FailureSlidingWindow(2, 60_000)
    w.record()
    w.record()
    expect(w.isTripped()).toBe(true)
    w.reset()
    expect(w.isTripped()).toBe(false)
    expect(w.count()).toBe(0)
  })
})
