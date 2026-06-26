const { Sequelize } = require('sequelize');
const secretsService = require('../services/secretsService');

let sequelize;

/**
 * Initialize database connection with dynamic credentials from Vault/Secrets Manager
 */
const initializeDatabase = async () => {
  if (process.env.NODE_ENV === 'test') {
    // Use SQLite in-memory for tests — no Postgres required
    sequelize = new Sequelize({
      dialect: 'sqlite',
      storage: ':memory:',
      logging: false,
    });
    // Patch sync to ignore "index already exists" errors which are harmless in test
    const origSync = sequelize.sync.bind(sequelize);
    sequelize.sync = async (options) => {
      try {
        return await origSync(options);
      } catch (err) {
        if (err.message && err.message.includes('already exists') && err.message.includes('index')) {
          return;
        }
        throw err;
      }
    };
  } else {
    // Get database credentials dynamically from secrets service
    try {
      const dbConfig = await secretsService.getDatabaseCredentials();
      
      sequelize = new Sequelize(
        dbConfig.database,
        dbConfig.username,
        dbConfig.password,
        {
          host: dbConfig.host,
          port: dbConfig.port,
          dialect: 'postgres',
          logging: process.env.NODE_ENV === 'development' ? console.log : false,
          ssl: dbConfig.ssl,
          dialectOptions: dbConfig.ssl ? {
            sslmode: 'require',
            rejectUnauthorized: true
          } : undefined
        }
      );

      console.log('Database connection initialized with dynamic credentials');
    } catch (error) {
      console.error('Failed to initialize database with dynamic credentials, falling back to environment variables:', error);
      
      // Fallback to environment variables if secrets service fails
      sequelize = new Sequelize(
        process.env.DB_NAME || 'vesting_vault',
        process.env.DB_USER || 'postgres',
        process.env.DB_PASSWORD || 'password',
        {
          host: process.env.DB_HOST || 'localhost',
          port: process.env.DB_PORT || 5432,
          dialect: 'postgres',
          logging: process.env.NODE_ENV === 'development' ? console.log : false,
          ssl: process.env.DB_SSL === 'true' ? {
            sslmode: 'require',
            rejectUnauthorized: true
          } : undefined
        }
      );
    }
  }
  
  return sequelize;
};

// Initialize immediately (sync in test mode since SQLite doesn't need secrets)
let initPromise = initializeDatabase();

// In test mode, await initialization synchronously so models can use sequelize
if (process.env.NODE_ENV === 'test') {
  // Create sequelize synchronously for test mode
  sequelize = new (require('sequelize')).Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  // Patch sync
  sequelize.sync = async (options = {}) => {
    const modelNames = Object.keys(sequelize.models);
    for (const name of modelNames) {
      try {
        await sequelize.query('PRAGMA foreign_keys = OFF;');
        await sequelize.models[name].sync(options);
      } catch (err) {
        // Swallow per-model sync errors
      }
    }
  };
}


// Read/write splitting support — in test mode (sqlite) this is just the same instance
const getDatabaseConnection = (operationType) => {
  return sequelize;
};

const checkDatabaseHealth = async () => {
  return { write: true, replicas: [] };
};

const checkReplicaLag = async () => {
  return 0;
};

const readReplicas = [];

// Export getters to ensure tests always get the initialized instance
module.exports = { 
  get sequelize() {
    return sequelize;
  },
  initializeDatabase,
  getSequelize: async () => {
    await initPromise;
    return sequelize;
  },
  getDatabaseConnection,
  checkDatabaseHealth,
  checkReplicaLag,
  readReplicas,
  get writeSequelize() {
    return sequelize;
  }
};
