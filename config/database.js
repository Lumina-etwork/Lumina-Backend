const { DataSource } = require('typeorm');
const { vaultManager } = require('./vault');

class DatabaseManager {
  constructor() {
    this.dataSource = null;
    this.isInitialized = false;
    this.connectionMetrics = {
      totalConnections: 0,
      activeConnections: 0,
      idleConnections: 0,
      failedConnections: 0,
      lastConnectionTime: null
    };
  }

  async createConnection() {
    // Ensure Vault is initialized before creating connection
    await vaultManager.initialize();
    const dbConfig = vaultManager.getDatabaseConfig();
    const appConfig = vaultManager.getApplicationConfig();

    this.dataSource = new DataSource({
      type: 'postgres',
      host: dbConfig.host,
      port: dbConfig.port,
      username: dbConfig.username,
      password: dbConfig.password,
      database: dbConfig.database,
      ssl: dbConfig.ssl ? { rejectUnauthorized: false } : false,
      
      // PgBouncer specific configuration
      extra: {
        max: dbConfig.pool_max,
        min: dbConfig.pool_min,
        idleTimeoutMillis: dbConfig.idle_timeout,
        connectionTimeoutMillis: dbConfig.connection_timeout,
        // PgBouncer specific settings
        application_name: 'vesting_vault_backend',
        connect_timeout_ms: dbConfig.connection_timeout,
        // Transaction pooling mode for PgBouncer
        pgbouncer: true
      },
      
      // TypeORM specific settings for connection pooling
      synchronize: appConfig.node_env !== 'production',
      logging: appConfig.node_env === 'development',
      entities: ['src/entities/**/*.js'],
      migrations: ['src/migrations/**/*.js'],
      subscribers: ['src/subscribers/**/*.js'],
      
      // Connection event handlers
      connect: () => {
        this.connectionMetrics.totalConnections++;
        this.connectionMetrics.activeConnections++;
        this.connectionMetrics.lastConnectionTime = new Date();
        console.log('Database connection established via PgBouncer');
      },
      
      disconnect: () => {
        this.connectionMetrics.activeConnections--;
        this.connectionMetrics.idleConnections++;
        console.log('Database connection closed');
      },
      
      error: (error) => {
        this.connectionMetrics.failedConnections++;
        console.error('Database connection error:', error);
      }
    });
    
    return this.dataSource;
  }

  async initialize() {
    if (this.isInitialized && this.dataSource?.isInitialized) {
      return this.dataSource;
    }

    try {
      if (!this.dataSource) {
        this.createConnection();
      }
      
      await this.dataSource.initialize();
      this.isInitialized = true;
      
      // Test PgBouncer connection
      await this.testPgBouncerConnection();
      
      console.log('Database initialized successfully with PgBouncer connection pooling');
      return this.dataSource;
    } catch (error) {
      console.error('Failed to initialize database with PgBouncer:', error);
      this.isInitialized = false;
      throw error;
    }
  }

  async testPgBouncerConnection() {
    try {
      // Test basic connectivity
      await this.dataSource.query('SELECT 1 as test');
      
      // Test PgBouncer specific features
      const poolInfo = await this.dataSource.query(`
        SHOW pool_status;
      `).catch(() => null);
      
      // Test transaction pooling
      await this.dataSource.query('BEGIN');
      await this.dataSource.query('COMMIT');
      
      console.log('PgBouncer connection test passed');
      return { success: true, poolInfo };
    } catch (error) {
      console.error('PgBouncer connection test failed:', error);
      throw error;
    }
  }

  async getConnectionMetrics() {
    try {
      // Get PgBouncer statistics
      const stats = await this.dataSource.query(`
        SHOW stats;
      `).catch(() => null);
      
      // Get pool information
      const pools = await this.dataSource.query(`
        SHOW pools;
      `).catch(() => null);
      
      return {
        applicationMetrics: this.connectionMetrics,
        pgbouncerStats: stats,
        poolInfo: pools,
        isInitialized: this.isInitialized
      };
    } catch (error) {
      console.error('Failed to get connection metrics:', error);
      return {
        applicationMetrics: this.connectionMetrics,
        isInitialized: this.isInitialized,
        error: error.message
      };
    }
  }

  async close() {
    if (this.dataSource && this.isInitialized) {
      await this.dataSource.destroy();
      this.isInitialized = false;
      console.log('Database connection closed');
    }
  }

  // Health check for PgBouncer
  async healthCheck() {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }
      
      const startTime = Date.now();
      await this.dataSource.query('SELECT 1');
      const responseTime = Date.now() - startTime;
      
      const metrics = await this.getConnectionMetrics();
      
      return {
        status: 'healthy',
        connection: 'pgbouncer',
        responseTime: `${responseTime}ms`,
        metrics
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        connection: 'pgbouncer',
        error: error.message
      };
    }
  }
}

const databaseManager = new DatabaseManager();
const databaseConfig = databaseManager.createConnection();

// Export only the config and manager
module.exports = { 
  databaseConfig, 
  databaseManager
};
