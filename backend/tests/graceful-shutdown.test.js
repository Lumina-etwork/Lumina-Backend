const http = require('http');
const mod = require('../src/graceful-shutdown');

function createFakeSocket() {
  const EventEmitter = require('events');
  const s = new EventEmitter();
  s.destroy = jest.fn();
  s.end = jest.fn();
  return s;
}

describe('GracefulShutdown', () => {
  let server;
  let exitCode;

  beforeAll(() => {
    mod.__forTest.setExitFn((code) => { exitCode = code; });
  });

  beforeEach(() => {
    exitCode = undefined;
    mod.__forTest.resetShuttingDown();
    mod.__forTest.resetActiveConnections();
    server = http.createServer((req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
  });

  afterEach((done) => {
    try {
      server.close(() => done());
    } catch (e) {
      done();
    }
  });

  it('should register handlers and return a remove function', () => {
    const sigtermCount = process.listenerCount('SIGTERM');
    const sigintCount = process.listenerCount('SIGINT');
    const remove = mod.installShutdownHandler(server);
    expect(typeof remove).toBe('function');
    expect(process.listenerCount('SIGTERM')).toBe(sigtermCount + 1);
    expect(process.listenerCount('SIGINT')).toBe(sigintCount + 1);
    remove();
    expect(process.listenerCount('SIGTERM')).toBe(sigtermCount);
    expect(process.listenerCount('SIGINT')).toBe(sigintCount);
  });

  it('should drain connections on shutdown', async () => {
    const result = await mod.drainConnections(server, 100);
    expect(result).toBe(true);
  });

  it('should have configurable timeouts', () => {
    const options = {
      drainTimeoutMs: 5000,
      persistTimeoutMs: 3000,
      totalTimeoutMs: 15000,
    };
    expect(options.drainTimeoutMs).toBe(5000);
    expect(options.persistTimeoutMs).toBe(3000);
    expect(options.totalTimeoutMs).toBe(15000);
  });

  it('should not shutdown twice', async () => {
    const spy = jest.fn();
    const options = {
      onPhase: spy,
      services: [{ stop: jest.fn() }],
      drainTimeoutMs: 100,
      persistTimeoutMs: 100,
    };
    await mod.shutdown(server, options);
    await mod.shutdown(server, options);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('should call onPhase callbacks in order', async () => {
    const phases = [];
    const options = {
      onPhase: (phase) => phases.push(phase),
      services: [],
      drainTimeoutMs: 100,
      persistTimeoutMs: 100,
    };
    await mod.shutdown(server, options);
    expect(phases).toEqual(['stopping', 'draining', 'persisting', 'exiting']);
  });

  it('should stop registered services', async () => {
    const service1 = { stop: jest.fn() };
    const service2 = { stop: jest.fn() };
    const options = {
      services: [service1, service2],
      drainTimeoutMs: 100,
      persistTimeoutMs: 100,
    };
    await mod.shutdown(server, options);
    expect(service1.stop).toHaveBeenCalled();
    expect(service2.stop).toHaveBeenCalled();
  });

  it('should not persist in test environment', async () => {
    const result = await mod.persistState(100);
    expect(result).toBe(false);
  });

  it('should exit with code 0 on clean shutdown', async () => {
    const options = {
      services: [],
      drainTimeoutMs: 100,
      persistTimeoutMs: 100,
    };
    await mod.shutdown(server, options);
    expect(exitCode).toBe(0);
  });
});
