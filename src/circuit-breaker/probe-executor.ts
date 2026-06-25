export interface ProbeResult {
  path: string
  success: boolean
  latencyMs: number
  error?: string
}

export class ProbeExecutor {
  private readonly probeTimeoutMs: number
  private readonly requiredSuccesses: number
  private activeProbes = new Set<string>()

  constructor(probeTimeoutMs = 2_000, requiredSuccesses = 2) {
    this.probeTimeoutMs = probeTimeoutMs
    this.requiredSuccesses = requiredSuccesses
  }

  async probe(upstreamUrl: string): Promise<boolean> {
    const upstreamId = this.extractId(upstreamUrl)

    if (this.activeProbes.has(upstreamId)) {
      return false
    }

    this.activeProbes.add(upstreamId)

    try {
      const results = await Promise.all([
        this.probeHealthEndpoint(upstreamUrl),
        this.probeSyntheticRequest(upstreamUrl),
        this.passiveLatencyCheck(upstreamUrl),
      ])

      const successes = results.filter((r) => r.success).length
      return successes >= this.requiredSuccesses
    } finally {
      this.activeProbes.delete(upstreamId)
    }
  }

  private async probeHealthEndpoint(upstreamUrl: string): Promise<ProbeResult> {
    const start = Date.now()
    try {
      const res = await fetch(`${upstreamUrl}/health`, {
        signal: AbortSignal.timeout(this.probeTimeoutMs),
      })
      return { path: "health", success: res.ok, latencyMs: Date.now() - start }
    } catch (err) {
      return {
        path: "health", success: false, latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  private async probeSyntheticRequest(upstreamUrl: string): Promise<ProbeResult> {
    const start = Date.now()
    try {
      const res = await fetch(upstreamUrl, {
        signal: AbortSignal.timeout(this.probeTimeoutMs),
      })
      return { path: "synthetic", success: res.ok, latencyMs: Date.now() - start }
    } catch (err) {
      return {
        path: "synthetic", success: false, latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  private async passiveLatencyCheck(_upstreamUrl: string): Promise<ProbeResult> {
    return { path: "passive", success: true, latencyMs: 0 }
  }

  private extractId(url: string): string {
    try { return new URL(url).hostname } catch { return url }
  }
}
