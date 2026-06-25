export interface HealthRecord {
  upstreamId: string
  healthy: boolean
  lastProbeAt: number
  lastProbeLatencyMs: number
  consecutiveFailures: number
  inMaintenance: boolean
}

interface MaintenanceWindow {
  startHour: number
  endHour: number
  timezone: string
}

export class UpstreamHealthCache {
  private records = new Map<string, HealthRecord>()
  private maintenanceWindows = new Map<string, MaintenanceWindow>()

  get(upstreamId: string): HealthRecord | undefined {
    return this.records.get(upstreamId)
  }

  set(record: HealthRecord): void {
    this.records.set(record.upstreamId, record)
  }

  getAll(): HealthRecord[] {
    return Array.from(this.records.values())
  }

  setMaintenanceWindow(upstreamId: string, window: MaintenanceWindow): void {
    this.maintenanceWindows.set(upstreamId, window)
  }

  isInMaintenanceWindow(upstreamId: string): boolean {
    const window = this.maintenanceWindows.get(upstreamId)
    if (!window) return false

    const now = new Date()
    const hour = now.getUTCHours()

    if (window.startHour <= window.endHour) {
      return hour >= window.startHour && hour < window.endHour
    }
    return hour >= window.startHour || hour < window.endHour
  }
}
