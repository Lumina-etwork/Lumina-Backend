require('reflect-metadata');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { databaseConfig } = require('./config/database');
const stellarService = require('./services/stellarService');
const authMiddleware = require('./middleware/auth');
const adminRoutes = require('./routes/admin');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    project: 'Vesting Vault', 
    status: 'Tracking Locked Tokens', 
    contract: 'CD5QF6KBAURVUNZR2EVBJISWSEYGDGEEYVH2XYJJADKT7KFOXTTIXLHU',
    database: databaseConfig.isInitialized ? 'connected' : 'disconnected'
  });
});

// Database health check
app.get('/health/db', async (req, res) => {
  try {
    if (!databaseConfig.isInitialized) {
      await databaseConfig.initialize();
    }
    await databaseConfig.query('SELECT 1');
    res.json({ status: 'healthy', connection: 'pgbouncer' });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

// Admin routes
app.use('/api/admin', adminRoutes);

// Initialize database connection
async function initializeApp() {
  try {
    await databaseConfig.initialize();
    console.log('Database connection established with PgBouncer');
    
    // Test Stellar service fallback mechanism
    await stellarService.testFallback();
    
    app.listen(port, () => {
      console.log(`Vesting API running on port ${port}`);
      console.log('PgBouncer connection pooling active');
    });
  } catch (error) {
    console.error('Failed to initialize application:', error);
    process.exit(1);
  }
}

initializeApp();

module.exports = app;
