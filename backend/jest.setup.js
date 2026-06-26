// jest.setup.js
require('dotenv').config({ path: '.env.test' });

jest.setTimeout(60000);

// Mock external services that cause side effects
jest.mock('ioredis', () => {
  const EventEmitter = require('events');
  const mockRedis = new EventEmitter();
  mockRedis.status = 'ready';
  mockRedis.connect = jest.fn().mockResolvedValue();
  mockRedis.disconnect = jest.fn();
  mockRedis.quit = jest.fn().mockResolvedValue('OK');
  mockRedis.get = jest.fn().mockResolvedValue(null);
  mockRedis.set = jest.fn().mockResolvedValue('OK');
  mockRedis.del = jest.fn().mockResolvedValue(1);
  mockRedis.keys = jest.fn().mockResolvedValue([]);
  mockRedis.ping = jest.fn().mockResolvedValue('PONG');
  mockRedis.on = jest.fn();
  // rate-limit-redis expects sendCommand to return a string for SCRIPT LOAD
  mockRedis.call = jest.fn().mockImplementation((...args) => {
    if (args[0] === 'SCRIPT' && args[1] === 'LOAD') {
      return Promise.resolve('sha1_hash_placeholder');
    }
    return Promise.resolve('OK');
  });
  mockRedis.defineCommand = jest.fn();
  mockRedis.duplicate = jest.fn().mockReturnValue(mockRedis);
  const Redis = jest.fn(() => mockRedis);
  Redis.prototype = mockRedis;
  return Redis;
});

jest.mock('bullmq', () => {
  const mockQueue = {
    add: jest.fn().mockResolvedValue({
      id: 'mock-job-id',
      waitUntilFinished: jest.fn().mockResolvedValue({}),
    }),
    close: jest.fn().mockResolvedValue(),
    on: jest.fn(),
    getWaiting: jest.fn().mockResolvedValue([]),
    getActive: jest.fn().mockResolvedValue([]),
    getCompleted: jest.fn().mockResolvedValue([]),
    getFailed: jest.fn().mockResolvedValue([]),
    obliterate: jest.fn().mockResolvedValue(),
  };
  const mockWorker = {
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(),
    run: jest.fn(),
  };
  const mockQueueEvents = jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(),
    waitUntilFinished: jest.fn().mockResolvedValue({}),
  }));
  return {
    Queue: jest.fn(() => mockQueue),
    Worker: jest.fn(() => mockWorker),
    QueueEvents: mockQueueEvents,
    QueueScheduler: jest.fn(() => ({ on: jest.fn(), close: jest.fn() })),
  };
});

jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  Handlers: {
    requestHandler: jest.fn(() => (req, res, next) => next()),
    errorHandler: jest.fn(() => (err, req, res, next) => next(err)),
    tracingHandler: jest.fn(() => (req, res, next) => next()),
  },
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  withScope: jest.fn(),
  startTransaction: jest.fn(),
  configureScope: jest.fn(),
}));

jest.mock('@sentry/profiling-node', () => ({
  nodeProfilingIntegration: jest.fn(() => ({})),
}));

jest.mock('firebase-admin', () => {
  const firestoreMock = {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn().mockResolvedValue({ exists: true, data: () => ({}) }),
        set: jest.fn().mockResolvedValue(),
        update: jest.fn().mockResolvedValue(),
        delete: jest.fn().mockResolvedValue(),
      })),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue({ docs: [], empty: true }),
      add: jest.fn().mockResolvedValue({ id: 'mock-doc-id' }),
    })),
  };
  const messagingMock = {
    send: jest.fn().mockResolvedValue({ messageId: 'mock-msg-id' }),
    sendEach: jest.fn().mockResolvedValue({ responses: [] }),
    sendMulticast: jest.fn().mockResolvedValue({ successCount: 1, failureCount: 0 }),
  };
  return {
    initializeApp: jest.fn(),
    credential: { applicationDefault: jest.fn(), cert: jest.fn() },
    firestore: jest.fn(() => firestoreMock),
    messaging: jest.fn(() => messagingMock),
    auth: jest.fn(() => ({
      verifyIdToken: jest.fn().mockResolvedValue({ uid: 'mock-uid' }),
      getUser: jest.fn().mockResolvedValue({ uid: 'mock-uid', email: 'test@test.com' }),
      createUser: jest.fn().mockResolvedValue({ uid: 'mock-uid' }),
    })),
    apps: [],
  };
});

const createStellarServerMock = () => ({
  getAccount: jest.fn().mockResolvedValue({
    id: 'GAAAA...',
    subentry_count: 0,
    balances: [],
  }),
  loadAccount: jest.fn().mockResolvedValue({}),
  transactions: jest.fn().mockReturnThis(),
  operations: jest.fn().mockReturnThis(),
  effects: jest.fn().mockReturnThis(),
  call: jest.fn().mockResolvedValue({ records: [] }),
  _sendResource: jest.fn(),
});

jest.mock('stellar-sdk', () => ({
  Server: jest.fn().mockImplementation(createStellarServerMock),
  rpc: {
    Server: jest.fn().mockImplementation(createStellarServerMock),
  },
  TransactionBuilder: jest.fn(),
  Operation: {
    payment: jest.fn(),
    changeTrust: jest.fn(),
    manageData: jest.fn(),
    setOptions: jest.fn(),
  },
  Asset: jest.fn(),
  Keypair: {
    fromSecret: jest.fn(),
    fromPublicKey: jest.fn(),
    random: jest.fn(),
  },
  Networks: {
    PUBLIC: 'Public Global Stellar Network ; September 2015',
    TESTNET: 'Test SDF Network ; September 2015',
  },
  BASE_FEE: '100',
  Memo: { text: jest.fn(), hash: jest.fn(), id: jest.fn() },
  TimeoutInfinite: 0,
  Auth: { revocable: '4', immutable: '8' },
  StrKey: {
    isValidEd25519PublicKey: jest.fn().mockReturnValue(true),
    isValidEd25519SecretSeed: jest.fn().mockReturnValue(true),
  },
  hash: jest.fn(),
  xdr: {},
  Address: jest.fn(),
  Horizon: jest.fn(),
  StellarTomlResolver: {
    resolve: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('express-rate-limit', () => {
  const fn = jest.fn(() => (req, res, next) => next());
  fn.rateLimit = fn;
  fn.default = fn;
  return fn;
});

// Mock ESM-only packages that Jest cannot transform
jest.mock('uuid', () => ({
  v4: () => '00000000-0000-0000-0000-000000000000',
  v7: () => '00000000-0000-0000-0000-000000000000',
}));

// Mock OpenTelemetry to prevent async SDK init leaks after tests
jest.mock('@opentelemetry/sdk-node', () => {
  const mockSdk = { start: jest.fn(), shutdown: jest.fn().mockResolvedValue() };
  try { const a = jest.requireActual('@opentelemetry/sdk-node'); return { ...a, NodeSDK: jest.fn(() => mockSdk) }; }
  catch { return { NodeSDK: jest.fn(() => mockSdk) }; }
});
jest.mock('@opentelemetry/exporter-otlp-grpc', () => {
  try { const a = jest.requireActual('@opentelemetry/exporter-otlp-grpc'); return { ...a, OTLPTraceExporter: jest.fn() }; }
  catch { return { OTLPTraceExporter: jest.fn() }; }
});
jest.mock('@opentelemetry/exporter-jaeger', () => {
  try { const a = jest.requireActual('@opentelemetry/exporter-jaeger'); return { ...a, JaegerExporter: jest.fn() }; }
  catch { return { JaegerExporter: jest.fn() }; }
});
jest.mock('@opentelemetry/resources', () => {
  try { const a = jest.requireActual('@opentelemetry/resources'); return { ...a, Resource: jest.fn() }; }
  catch { return { Resource: jest.fn() }; }
});
jest.mock('@opentelemetry/semantic-conventions', () => {
  try { return jest.requireActual('@opentelemetry/semantic-conventions'); }
  catch { return { SemanticResourceAttributes: { SERVICE_NAME: 'service.name', SERVICE_VERSION: 'service.version', DEPLOYMENT_ENVIRONMENT: 'deployment.environment' } }; }
});
jest.mock('@opentelemetry/api', () => {
  const mockSpan = {
    end: jest.fn(),
    setAttribute: jest.fn(),
    setAttributes: jest.fn(),
    addEvent: jest.fn(),
    setStatus: jest.fn(),
    recordException: jest.fn(),
    updateName: jest.fn(),
    spanContext: jest.fn(() => ({ traceId: 'mock', spanId: 'mock', traceFlags: 1 })),
    isRecording: jest.fn().mockReturnValue(false),
  };
  const mockTracer = {
    startSpan: jest.fn(() => mockSpan),
    startActiveSpan: jest.fn((name, fn) => fn(mockSpan)),
  };
  try {
    const a = jest.requireActual('@opentelemetry/api');
    return { ...a, trace: { ...a.trace, getTracer: jest.fn(() => mockTracer) } };
  } catch {
    return {
      trace: { getTracer: jest.fn(() => mockTracer) },
      SpanStatusCode: { OK: 0, ERROR: 1, UNSET: 2 },
      SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 },
      context: { active: jest.fn(), with: jest.fn(), bind: jest.fn() },
      propagation: {},
      diag: { setLogger: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    };
  }
});
jest.mock('@opentelemetry/auto-instrumentations-node', () => {
  try { const a = jest.requireActual('@opentelemetry/auto-instrumentations-node'); return { ...a, getNodeAutoInstrumentations: jest.fn() }; }
  catch { return { getNodeAutoInstrumentations: jest.fn() }; }
});

// Mock firebase-admin globally to avoid requiring service account file
jest.mock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  messaging: jest.fn(() => ({
    sendEachForMulticast: jest.fn().mockResolvedValue({ successCount: 0, failureCount: 0 }),
  })),
}));

// Setup OpenAPI validation for tests
try {
  const jestOpenAPI = require('jest-openapi').default;
  const swaggerSpec = require('./src/swagger/options');
  jestOpenAPI(swaggerSpec);
} catch (error) {
  console.warn('OpenAPI validation setup failed (optional):', error.message);
}
