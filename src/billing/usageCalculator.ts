import { redis } from '../metering/redisClient';

export class UsageCalculator {
  public async getUsage(tenantId: string): Promise<number> {
    const bytes = await redis.get(`tenant:${tenantId}:bytes`);
    return bytes ? parseInt(bytes, 10) : 0;
  }
}
