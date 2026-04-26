require('reflect-metadata');
const express = require('express');
const cors = require('cors');
const { vaultManager } = require('./config/vault');

const { databaseManager } = require('./config/database');
const stellarService = require('./services/stellarService');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');

const app = express();
let port = 3000; // Default, will be updated from Vault

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    project: 'Vesting Vault', 
    status: 'Tracking Locked Tokens', 
    contract: 'CD5QF6KBAURVUNZR2EVBJISWSEYGDGEEYVH2XYJJADKT7KFOXTTIXLHU',
    database: databaseManager.isInitialized ? 'connected' : 'disconnected'
  });
});

// Database health check with PgBouncer metrics
app.get('/health/db', async (req, res) => {
  try {
    const healthResult = await databaseManager.healthCheck();
    res.json(healthResult);
  } catch (error) {
    res.status(500).json({ 
      status: 'unhealthy', 
      connection: 'pgbouncer',
      error: error.message 
    });
  }
});

// PgBouncer metrics endpoint
app.get('/metrics/pgbouncer', async (req, res) => {
  try {
    const metrics = await databaseManager.getConnectionMetrics();
    res.json(metrics);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get PgBouncer metrics',
      details: error.message
    });
  }
});

// Auth routes
app.use('/api/auth', authRoutes);

// Admin routes
app.use('/api/admin', adminRoutes);

// Initialize database connection
async function initializeApp() {
  try {
    // Initialize Vault and get configuration
    await vaultManager.initialize();
    const appConfig = vaultManager.getApplicationConfig();
    port = appConfig.port;
    
    await databaseManager.initialize();
    console.log('Database connection established with PgBouncer');
    
    // Initialize Stellar service with Vault secrets
    await stellarService.initializeFromVault();
    
    // Test Stellar service fallback mechanism
    await stellarService.testFallback();
    
    app.listen(port, () => {
      console.log(`Vesting API running on port ${port}`);
      console.log('PgBouncer connection pooling active');
      console.log('Vault secrets management enabled');
    });
  } catch (error) {
    console.error('Failed to initialize application:', error);
    process.exit(1);
  }
}

// Only initialize if not in test mode
if (process.env.NODE_ENV !== 'test') {
  initializeApp();
}

module.exports = app;
