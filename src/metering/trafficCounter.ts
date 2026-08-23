import { redis } from './redisClient';

const FLUSH_INTERVAL_MS = 100;

export class TrafficCounter {
  private buffer = new Map<string, number>();
  
  constructor() {
    setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  public recordTraffic(tenantId: string, bytes: number) {
    const current = this.buffer.get(tenantId) || 0;
    this.buffer.set(tenantId, current + bytes);
  }

  private async flush() {
    if (this.buffer.size === 0) return;
    const entries = Array.from(this.buffer.entries());
    this.buffer.clear();

    const pipeline = redis.pipeline();
    for (const [tenantId, bytes] of entries) {
      pipeline.incrby(`tenant:${tenantId}:bytes`, bytes);
    }
    await pipeline.exec();
  }
}
