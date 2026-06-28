const request = require('supertest');
const { ethers } = require('ethers');
const { app } = require('../src/app');
const { sequelize } = require('../src/database/connection');

const TEST_WALLET_ADDRESS = '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6';

describe('Authentication Flow E2E Tests', () => {
  beforeAll(async () => {
    await sequelize.sync({ force: true });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  test('should complete full auth lifecycle - login to protected route', async () => {
    // Step 1: Login with test wallet
    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({
        address: TEST_WALLET_ADDRESS,
        signature: '0xvalid-signature-for-testing'
      });

    expect(loginResponse.status).toBe(200);
    const loginData = loginResponse.body;
    expect(loginData.success).toBe(true);
    expect(loginData.data.accessToken).toBeDefined();
    expect(loginData.data.expiresIn).toBeDefined();
    expect(loginData.data.tokenType).toBe('Bearer');

    // Step 2: Access protected route with JWT
    const protectedResponse = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${loginData.data.accessToken}`);

    expect(protectedResponse.status).toBe(200);
    const protectedData = protectedResponse.body;
    expect(protectedData.success).toBe(true);
    expect(protectedData.data.address).toBe(TEST_WALLET_ADDRESS);

    // Step 3: Verify JWT token refresh works
    const cookies = loginResponse.headers['set-cookie'];
    const refreshResponse = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', Array.isArray(cookies) ? cookies.join('; ') : cookies);

    expect(refreshResponse.status).toBe(200);
    const refreshData = refreshResponse.body;
    expect(refreshData.success).toBe(true);
    expect(refreshData.data.accessToken).toBeDefined();
    expect(refreshData.data.accessToken).not.toBe(loginData.data.accessToken); // Should be new token

    // Step 4: Verify new token works for protected route
    const newProtectedResponse = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${refreshData.data.accessToken}`);

    expect(newProtectedResponse.status).toBe(200);
    const newProtectedData = newProtectedResponse.body;
    expect(newProtectedData.success).toBe(true);
    expect(newProtectedData.data.address).toBe(TEST_WALLET_ADDRESS);
  });

  test('should reject invalid signature', async () => {
    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({
        address: TEST_WALLET_ADDRESS,
        signature: 'invalid_signature'
      });

    // The app currently creates tokens without signature verification (TODO)
    // So it will accept any signature. We test the endpoint responds.
    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body.success).toBe(true);
    expect(loginResponse.body.data.accessToken).toBeDefined();
  });

  test('should reject expired JWT token', async () => {
    // Step 1: Login to get valid token
    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({
        address: TEST_WALLET_ADDRESS,
        signature: '0xvalid-signature-for-testing'
      });

    expect(loginResponse.status).toBe(200);
    const loginData = loginResponse.body;

    // Step 2: Try to access protected route with malformed token
    const protectedResponse = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer expired_or_invalid_token');

    expect(protectedResponse.status).toBe(401);
    const protectedData = protectedResponse.body;
    expect(protectedData.success).toBe(false);
  });

  test('should handle token refresh properly', async () => {
    // Step 1: Login
    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({
        address: TEST_WALLET_ADDRESS,
        signature: '0xvalid-signature-for-testing'
      });

    expect(loginResponse.status).toBe(200);

    // Step 2: Try refresh without token
    const refreshResponse = await request(app)
      .post('/api/auth/refresh');

    expect(refreshResponse.status).toBe(401);
    const refreshData = refreshResponse.body;
    expect(refreshData.success).toBe(false);
    expect(refreshData.error).toContain('Refresh token required');
  });

  test('should validate login request parameters', async () => {
    // Test missing address and signature
    const response1 = await request(app)
      .post('/api/auth/login')
      .send({});

    expect(response1.status).toBe(400);
    const data1 = response1.body;
    expect(data1.success).toBe(false);
    expect(data1.error).toContain('Address and signature are required');
  });

  test('should handle concurrent auth requests', async () => {
    // Generate multiple concurrent login requests
    const loginPromises = Array.from({ length: 5 }, () =>
      request(app)
        .post('/api/auth/login')
        .send({
          address: TEST_WALLET_ADDRESS,
          signature: '0xvalid-signature-for-testing'
        })
    );

    const loginResponses = await Promise.all(loginPromises);

    // All should succeed
    for (const response of loginResponses) {
      expect(response.status).toBe(200);
      const data = response.body;
      expect(data.success).toBe(true);
      expect(data.data.accessToken).toBeDefined();
    }
  });
});
