import { TrafficCounter } from '../trafficCounter';
import { redis } from '../redisClient';

jest.mock('../redisClient', () => ({
  redis: {
    pipeline: jest.fn().mockReturnValue({
      incrby: jest.fn(),
      exec: jest.fn().mockResolvedValue([]),
    }),
  },
}));

describe('TrafficCounter', () => {
  it('buffers and flushes concurrently', async () => {
    const counter = new TrafficCounter();
    
    const numCalls = 100;
    const promises = [];
    for (let i = 0; i < numCalls; i++) {
      promises.push(Promise.resolve().then(() => counter.recordTraffic('tenant1', 100)));
    }
    await Promise.all(promises);

    // Force flush
    await (counter as any).flush();

    expect(redis.pipeline().incrby).toHaveBeenCalledWith('tenant:tenant1:bytes', 10000);
  });
});
