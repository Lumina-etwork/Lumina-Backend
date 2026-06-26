const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../src/app');
const { sequelize } = require('../src/database/connection');
const authService = require('../src/services/authService');

const TEST_WALLET_ADDRESS = '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6';

describe('Authentication Integration Tests', () => {
  beforeAll(async () => {
    await sequelize.sync();
  });

  afterAll(async () => {
    await sequelize.close();
  });

  describe('Login', () => {
    test('should authenticate with valid address and signature', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          address: TEST_WALLET_ADDRESS,
          signature: '0xvalid-signature'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.accessToken).toBeDefined();
      expect(response.body.data.expiresIn).toBeDefined();
      expect(response.body.data.tokenType).toBe('Bearer');
    });

    test('should reject login with missing address', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ signature: '0xsig' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Address');
    });

    test('should reject login with missing signature', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ address: TEST_WALLET_ADDRESS });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('signature');
    });
  });

  describe('JWT Token Flow', () => {
    let accessToken;
    let refreshTokenCookie;

    test('should login and receive tokens', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          address: TEST_WALLET_ADDRESS,
          signature: '0xvalid-signature'
        });

      expect(response.status).toBe(200);
      accessToken = response.body.data.accessToken;
      refreshTokenCookie = response.headers['set-cookie'];

      expect(accessToken).toBeDefined();
      expect(refreshTokenCookie).toBeDefined();
    });

    test('should get current user info with valid JWT', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.address).toBe(TEST_WALLET_ADDRESS);
    });

    test('should reject /auth/me without JWT', async () => {
      const response = await request(app)
        .get('/api/auth/me');

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });

    test('should reject /auth/me with invalid JWT', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer invalid_token');

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });

    test('should refresh JWT token', async () => {
      const response = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', refreshTokenCookie);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.accessToken).toBeDefined();
      expect(response.body.data.accessToken).not.toBe(accessToken);
    });

    test('should reject refresh without token', async () => {
      const response = await request(app)
        .post('/api/auth/refresh');

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Refresh token required');
    });
  });

  describe('Token Validation', () => {
    test('should generate valid JWT structure', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          address: TEST_WALLET_ADDRESS,
          signature: '0xvalid-signature'
        });

      const token = response.body.data.accessToken;

      const parts = token.split('.');
      expect(parts).toHaveLength(3);

      const header = JSON.parse(Buffer.from(parts[0], 'base64').toString());
      expect(header.alg).toBeDefined();

      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      expect(payload.address).toBe(TEST_WALLET_ADDRESS);
      expect(payload.iat).toBeDefined();
      expect(payload.exp).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    test('should handle malformed request bodies', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send('invalid_json')
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(400);
    });

    test('should handle missing required fields', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          address: TEST_WALLET_ADDRESS
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('signature');
    });
  });
});
