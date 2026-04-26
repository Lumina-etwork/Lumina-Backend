const request = require('supertest');
const app = require('../index');

describe('Vesting Vault API', () => {
  describe('GET /', () => {
    it('should return application information', async () => {
      const response = await request(app)
        .get('/')
        .expect(200);

      expect(response.body).toHaveProperty('project', 'Vesting Vault');
      expect(response.body).toHaveProperty('status', 'Tracking Locked Tokens');
      expect(response.body).toHaveProperty('contract');
      expect(response.body).toHaveProperty('database');
    });
  });

  describe('GET /health/db', () => {
    it('should return database health status', async () => {
      const response = await request(app)
        .get('/health/db')
        .expect(200);

      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('connection', 'pgbouncer');
    });
  });
});

describe('Admin Routes', () => {
  describe('GET /api/admin/status', () => {
    it('should require authentication', async () => {
      await request(app)
        .get('/api/admin/status')
        .expect(401);
    });
  });

  describe('POST /api/admin/multisig/add-member', () => {
    it('should require signature verification', async () => {
      await request(app)
        .post('/api/admin/multisig/add-member')
        .send({
          accountId: 'GD5QF6KBAURVUNZR2EVBJISWSEYGDGEEYVH2XYJJADKT7KFOXTTIXLHU',
          weight: 1
        })
        .expect(401);
    });
  });
});
