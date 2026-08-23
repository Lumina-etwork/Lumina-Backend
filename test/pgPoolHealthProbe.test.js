const PgPoolHealthProbe = require('../src/services/pgPoolHealthProbe');
const { Pool } = require('pg');

jest.mock('pg', () => {
  const mPool = {
    connect: jest.fn(),
    options: { max: 10 }
  };
  return { Pool: jest.fn(() => mPool) };
});

describe('PgPoolHealthProbe', () => {
  let pool;
  let probe;

  beforeEach(() => {
    pool = new Pool();
    probe = new PgPoolHealthProbe(pool, {
      interval: 1000,
      minConnections: 10,
      maxConnections: 200,
      Kp: 0.5,
      Ki: 0.1,
      Kd: 0.05,
      cooldownMs: 0
    });
    jest.useFakeTimers();
  });

  afterEach(() => {
    probe.stop();
    jest.clearAllTimers();
    jest.restoreAllMocks();
  });

  it('should auto-scale pool on load spike', async () => {
    // Simulate low wait times initially
    let queryFn = jest.fn().mockResolvedValue();
    let releaseFn = jest.fn();
    
    let mockClient = { query: queryFn, release: releaseFn };
    pool.connect.mockResolvedValue(mockClient);

    // Initial state
    expect(probe.targetPoolSize).toBe(10);
    
    // Simulate probe tick
    await probe.probeTick();
    expect(probe.targetPoolSize).toBe(10); // Should not scale up since wait < 50
    
    // Simulate a load spike where wait time > 50ms and query latency < 100ms
    pool.connect.mockImplementation(() => {
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve({
                    query: () => new Promise(res => setTimeout(res, 10)),
                    release: jest.fn()
                });
            }, 60); // Wait time = 60ms (> 50ms threshold)
        });
    });

    probe.waitTimes.push(60); // Inject a manual sample
    probe.queryLatencies.push(10); // Inject a manual sample
    
    // Mock the date to pass cooldown check
    jest.spyOn(Date, 'now').mockImplementation(() => 100000);
    
    // Note: error = target_p95 (100) - actual_p95 (10) = 90
    // adjustment = Kp*90 = 45 -> clamped to 5
    // Wait > 50, so scaling up is allowed.
    await probe.probeTick();
    
    expect(probe.targetPoolSize).toBe(15);
  });
});
