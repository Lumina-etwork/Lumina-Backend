// Test setup file
process.env.NODE_ENV = 'test';
process.env.DB_HOST = 'localhost';
process.env.DB_PORT = '6432'; // PgBouncer port
process.env.DB_USERNAME = 'postgres';
process.env.DB_PASSWORD = 'postgres';
process.env.DB_NAME = 'vesting_vault_test';
process.env.DB_SSL = 'false';
process.env.DB_POOL_MAX = '20';
process.env.DB_POOL_MIN = '5';
process.env.DB_IDLE_TIMEOUT = '30000';
process.env.DB_CONNECTION_TIMEOUT = '2000';
process.env.ADMIN_SIGNATURE_REQUIRED = 'true';
process.env.STELLAR_HORIZON_PRIMARY = 'https://horizon-testnet.stellar.org';
process.env.STELLAR_HORIZON_FALLBACK = 'https://horizon.stellar.org';
process.env.STELLAR_SOROBAN_RPC = 'https://soroban-rpc.stellar.org';

// Mock console methods during tests
const originalConsole = global.console;
beforeAll(() => {
  global.console = {
    ...originalConsole,
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  };
});

afterAll(() => {
  global.console = originalConsole;
});
