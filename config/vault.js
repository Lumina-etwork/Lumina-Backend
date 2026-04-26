const vault = require('node-vault');

class VaultManager {
  constructor() {
    this.client = null;
    this.secrets = {};
    this.isInitialized = false;
    this.retryAttempts = 3;
    this.retryDelay = 1000; // 1 second
  }

  async initialize() {
    if (this.isInitialized) {
      return this.secrets;
    }

    try {
      // Initialize Vault client
      this.client = vault({
        endpoint: process.env.VAULT_ADDR || 'http://localhost:8200',
        token: process.env.VAULT_TOKEN || this.getAppToken(),
      });

      // Test Vault connection
      await this.testConnection();
      
      // Fetch all secrets
      await this.fetchAllSecrets();
      
      this.isInitialized = true;
      console.log('Vault client initialized successfully');
      return this.secrets;
    } catch (error) {
      console.error('Failed to initialize Vault client:', error);
      throw error;
    }
  }

  getAppToken() {
    try {
      const fs = require('fs');
      const path = require('path');
      const tokenPath = path.join(__dirname, '../vault-data/app-token.txt');
      
      if (fs.existsSync(tokenPath)) {
        const tokenContent = fs.readFileSync(tokenPath, 'utf8');
        const tokenMatch = tokenContent.match(/token\s+(hvs\.[^\s]+)/);
        return tokenMatch ? tokenMatch[1] : null;
      }
    } catch (error) {
      console.warn('Could not read Vault token from file:', error.message);
    }
    return null;
  }

  async testConnection() {
    try {
      await this.client.health();
      console.log('Vault connection test successful');
    } catch (error) {
      throw new Error(`Vault connection failed: ${error.message}`);
    }
  }

  async fetchSecret(path, key) {
    if (!this.client) {
      throw new Error('Vault client not initialized');
    }

    try {
      const result = await this.withRetry(async () => {
        return await this.client.read(`secret/data/${path}`);
      });

      if (result && result.data && result.data.data) {
        return result.data.data[key];
      }
      throw new Error(`Secret not found: ${path}/${key}`);
    } catch (error) {
      console.error(`Failed to fetch secret ${path}/${key}:`, error);
      throw error;
    }
  }

  async fetchAllSecrets() {
    try {
      // Fetch database secrets
      const dbSecrets = await this.withRetry(async () => {
        return await this.client.read('secret/data/vesting-vault/database');
      });

      // Fetch application secrets
      const appSecrets = await this.withRetry(async () => {
        return await this.client.read('secret/data/vesting-vault/application');
      });

      // Fetch stellar secrets
      const stellarSecrets = await this.withRetry(async () => {
        return await this.client.read('secret/data/vesting-vault/stellar');
      });

      // Store secrets in structured format
      this.secrets = {
        database: dbSecrets?.data?.data || {},
        application: appSecrets?.data?.data || {},
        stellar: stellarSecrets?.data?.data || {}
      };

      console.log('All secrets fetched successfully from Vault');
      return this.secrets;
    } catch (error) {
      console.error('Failed to fetch secrets from Vault:', error);
      throw error;
    }
  }

  async withRetry(operation) {
    let lastError;
    
    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        
        if (attempt < this.retryAttempts) {
          console.warn(`Vault operation failed (attempt ${attempt}/${this.retryAttempts}), retrying...`);
          await this.delay(this.retryDelay * attempt);
        }
      }
    }
    
    throw lastError;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getSecret(category, key, defaultValue = null) {
    if (!this.isInitialized) {
      console.warn('Vault not initialized, returning default value');
      return defaultValue;
    }

    if (this.secrets[category] && this.secrets[category][key] !== undefined) {
      return this.secrets[category][key];
    }

    console.warn(`Secret not found: ${category}/${key}, returning default value`);
    return defaultValue;
  }

  // Helper method to get database configuration
  getDatabaseConfig() {
    return {
      host: this.getSecret('database', 'host', 'localhost'),
      port: parseInt(this.getSecret('database', 'port', '6432')),
      username: this.getSecret('database', 'username', 'postgres'),
      password: this.getSecret('database', 'password', 'password'),
      database: this.getSecret('database', 'name', 'vesting_vault'),
      ssl: this.getSecret('database', 'ssl', 'false') === 'true',
      pool_max: parseInt(this.getSecret('database', 'pool_max', '20')),
      pool_min: parseInt(this.getSecret('database', 'pool_min', '5')),
      idle_timeout: parseInt(this.getSecret('database', 'idle_timeout', '30000')),
      connection_timeout: parseInt(this.getSecret('database', 'connection_timeout', '2000'))
    };
  }

  // Helper method to get application configuration
  getApplicationConfig() {
    return {
      node_env: this.getSecret('application', 'node_env', 'development'),
      port: parseInt(this.getSecret('application', 'port', '3000')),
      jwt_secret: this.getSecret('application', 'jwt_secret', 'your-jwt-secret-key'),
      admin_signature_required: this.getSecret('application', 'admin_signature_required', 'true') === 'true'
    };
  }

  // Helper method to get stellar configuration
  getStellarConfig() {
    return {
      horizon_primary: this.getSecret('stellar', 'horizon_primary', 'https://horizon.stellar.org'),
      horizon_fallback: this.getSecret('stellar', 'horizon_fallback', 'https://horizon-testnet.stellar.org'),
      soroban_rpc: this.getSecret('stellar', 'soroban_rpc', 'https://soroban-rpc.stellar.org')
    };
  }

  // Health check method
  async healthCheck() {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }
      
      const health = await this.client.health();
      return {
        status: 'healthy',
        vault: health,
        secrets_loaded: Object.keys(this.secrets).length,
        initialized: this.isInitialized
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        initialized: this.isInitialized
      };
    }
  }
}

// Create singleton instance
const vaultManager = new VaultManager();

module.exports = {
  vaultManager,
  // Convenience exports for backward compatibility
  getDatabaseConfig: () => vaultManager.getDatabaseConfig(),
  getApplicationConfig: () => vaultManager.getApplicationConfig(),
  getStellarConfig: () => vaultManager.getStellarConfig()
};
