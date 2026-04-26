const { Sequelize } = require('sequelize');
const { vaultManager } = require('../../../config/vault');

// Initialize sequelize with Vault secrets
let sequelize;

const initializeDatabase = async () => {
  await vaultManager.initialize();
  const dbConfig = vaultManager.getDatabaseConfig();
  const appConfig = vaultManager.getApplicationConfig();

  sequelize = new Sequelize(
    dbConfig.database,
    dbConfig.username,
    dbConfig.password,
    {
      host: dbConfig.host,
      port: dbConfig.port,
      dialect: 'postgres',
      logging: appConfig.node_env === 'development' ? console.log : false,
    }
  );

  return sequelize;
};

// Export a promise that resolves to the initialized sequelize instance
module.exports = {
  sequelizePromise: initializeDatabase(),
  getSequelize: () => sequelize
};
