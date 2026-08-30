const { initializeTracing } = require('./tracing/tracing');
initializeTracing();

const dotenv = require('dotenv');
dotenv.config();

const Sentry = require('@sentry/node');
const { nodeProfilingIntegration } = require('@sentry/profiling-node');

Sentry.init({
  dsn: process.env.SENTRY_DSN || "http://public_key@localhost:9999/1",
  debug: process.env.NODE_ENV !== "test",
  environment: process.env.NODE_ENV || "development",
  integrations: [nodeProfilingIntegration()],
  tracesSampleRate: 1.0,
  profilesSampleRate: 1.0,
});

const { app, httpServer } = require('./app');
const PORT = process.env.PORT || 4000;

const metricsService = require('./services/metricsService');
const claimWebhookListenerService = require('./services/claimWebhookListenerService');
const stellarPathPaymentListener = require('./services/stellarPathPaymentListener');
const kycExpirationWorker = require('./jobs/kycExpirationWorker');
const gdprComplianceJob = require('./jobs/gdprComplianceJob');
const historicalPriceTrackingJob = require('./jobs/historicalPriceTrackingJob');
const vaultBalanceMonitoringJob = require('./jobs/vaultBalanceMonitoringJob');
const VestingStateReconciliationJob = require('./jobs/vestingStateReconciliationJob');
const SecretRotationJob = require('./jobs/secretRotationJob');

const startServer = async () => {
  const secretsService = require('./services/secretsService');
  const { getSequelize } = require('./database/connection');
  const cacheService = require('./services/cacheService');
  const discordBotService = require('./services/discordBotService');
  const notificationService = require('./services/notificationService');
  const monthlyReportJob = require('./jobs/monthlyReportJob');
  const { VaultReconciliationJob } = require('./jobs/vaultReconciliationJob');
  const vaultRegistryIndexingJob = require('./jobs/vaultRegistryIndexingJob');

  try {
    try {
      await secretsService.initialize();
      console.log('Secrets service initialized successfully.');
    } catch (secretsError) {
      console.error('Failed to initialize secrets service:', secretsError);
      console.log('Continuing with environment variables...');
    }

    const sequelize = await getSequelize();
    await sequelize.authenticate();
    console.log("Database connection established successfully.");
    await sequelize.sync();
    console.log("Database synchronized successfully.");

    try {
      const SEP12Module = require('./services/sep12Module');
      const sep12Module = new SEP12Module({ sequelize });
      await sep12Module.initialize();
      sep12Module.registerRoutes(app);
      console.log('SEP-12 KYC Module initialized successfully.');
    } catch (sep12Error) {
      console.error('Failed to initialize SEP-12 KYC Module:', sep12Error);
      console.log('Continuing without SEP-12 KYC functionality...');
    }

    try {
      const VestingUpdateWebSocket = require('./websocket/vesting-update.websocket');
      const vestingUpdateWebSocket = new VestingUpdateWebSocket(httpServer);
      console.log('WebSocket server initialized successfully.');
    } catch (wsError) {
      console.error('Failed to initialize WebSocket:', wsError);
      console.log('Continuing with REST API only...');
    }

    try {
      const DashboardGateway = require('./websocket/dashboard-gateway.gateway');
      const dashboardGateway = new DashboardGateway(httpServer);
      console.log('Dashboard Gateway initialized successfully.');
    } catch (gatewayError) {
      console.error('Failed to initialize Dashboard Gateway:', gatewayError);
      console.log('Continuing without enhanced dashboard features...');
    }

    try {
      await cacheService.connect();
      if (cacheService.isReady()) {
        console.log("Redis cache connected successfully.");
      } else {
        console.log("Redis cache not available, continuing without caching...");
      }
    } catch (cacheError) {
      console.error("Failed to connect to Redis:", cacheError);
      console.log("Continuing without Redis cache...");
    }

    let graphQLServer = null;
    try {
      const { GraphQLServer } = require("./graphql/server");
      graphQLServer = new GraphQLServer(app, httpServer);
      await graphQLServer.start();
      await graphQLServer.applyMiddleware(app);
      console.log("GraphQL Server initialized successfully.");
      const serverInfo = graphQLServer.getServerInfo();
      console.log(`GraphQL Playground available at: ${serverInfo.playgroundUrl}`);
      console.log(`GraphQL Subscriptions available at: ${serverInfo.subscriptionEndpoint}`);
    } catch (graphqlError) {
      console.error("Failed to initialize GraphQL Server:", graphqlError);
      console.log("Continuing with REST API only...");
    }

    try {
      await discordBotService.start();
    } catch (discordError) {
      console.error("Failed to initialize Discord Bot:", discordError);
      console.log("Continuing without Discord bot...");
    }

    try {
      monthlyReportJob.start();
    } catch (jobError) {
      console.error("Failed to initialize Monthly Report Job:", jobError);
    }

    const vaultReconciliationJob = new VaultReconciliationJob();
    try {
      vaultReconciliationJob.start();
      console.log("Vault Reconciliation Job started successfully.");
    } catch (jobError) {
      console.error("Failed to initialize Vault Reconciliation Job:", jobError);
    }

    try {
      notificationService.start();
      console.log("Notification service started successfully.");
    } catch (notificationError) {
      console.error("Failed to initialize Notification Service:", notificationError);
    }

    try {
      vaultRegistryIndexingJob.start();
      console.log("Vault Registry Indexing Job started successfully.");
    } catch (jobError) {
      console.error("Failed to initialize Vault Registry Indexing Job:", jobError);
    }

    let backupVerificationJob = null;
    try {
      const { BackupVerificationJob } = require('./jobs/backupVerificationJob');
      backupVerificationJob = new BackupVerificationJob();
      backupVerificationJob.start();
      console.log("Backup Verification Job started successfully.");
    } catch (jobError) {
      console.error("Failed to initialize Backup Verification Job:", jobError);
    }

    httpServer.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`REST API available at: http://localhost:${PORT}`);
      if (graphQLServer) {
        console.log(`GraphQL API available at: http://localhost:${PORT}/graphql`);
      }
      // Install graceful shutdown handler
      const { installShutdownHandler } = require('./graceful-shutdown');
      installShutdownHandler(httpServer, {
        services: [
          vaultReconciliationJob,
          notificationService,
          vaultRegistryIndexingJob,
          backupVerificationJob,
        ].filter(Boolean),
        onPhase: (phase) => {
          try {
            const metricsService = require('./services/metricsService');
            if (metricsService.shutdownPhase) {
              metricsService.shutdownPhase.set({ phase });
            }
          } catch (e) {
            // metrics not available
          }
        },
        onError: (err) => {
          console.error('[GracefulShutdown] Error during shutdown:', err);
        },
      });
    });
  } catch (error) {
    console.error('Unable to start server:', error);
    process.exit(1);
  }
};

if (require.main === module) {
  // Initialize Vault Balance Monitoring Job
  try {
    vaultBalanceMonitoringJob.start();
    console.log("Vault Balance Monitoring Job started successfully.");
  } catch (jobError) {
    console.error("Failed to initialize Vault Balance Monitoring Job:", jobError);
  }

  // Initialize Vesting State Reconciliation Job
  try {
    const vestingStateReconciliationJob = new VestingStateReconciliationJob();
    vestingStateReconciliationJob.start();
    console.log("Vesting State Reconciliation Job started successfully.");
  } catch (jobError) {
    console.error("Failed to initialize Vesting State Reconciliation Job:", jobError);
  }

  // Initialize claim webhook listener
  try {
    claimWebhookListenerService.start();
    console.log("Claim Webhook Listener started successfully.");
  } catch (listenerError) {
    console.error("Failed to initialize Claim Webhook Listener:", listenerError);
  }

  // Initialize Stellar Path Payment Listener
  try {
    stellarPathPaymentListener.start();
    console.log("Stellar Path Payment Listener started successfully.");
  } catch (listenerError) {
    console.error("Failed to initialize Stellar Path Payment Listener:", listenerError);
  }

  // Start background metrics collection
  setInterval(async () => {
    try {
      const { activeDbConnections, totalIndexedBlocks } = metricsService;
      const { writeSequelize } = require('./database/connection');
      if (writeSequelize && writeSequelize.connectionManager && writeSequelize.connectionManager.pool) {
        const activeConnections = writeSequelize.connectionManager.pool.size - writeSequelize.connectionManager.pool.available;
        activeDbConnections.set(activeConnections);
      }

      const { ClaimsHistory } = require('./models');
      const maxBlock = await ClaimsHistory.max('block_number');
      if (maxBlock) {
        totalIndexedBlocks.set(parseInt(maxBlock));
      }
    } catch (error) {
      console.error('Error updating metrics:', error);
    }
  }, 15000);

  // Initialize Soroban Event Poller Service
  (async () => {
    try {
      const SorobanEventPollerService = require('./services/sorobanEventPollerService');
      const SorobanEventProcessor = require('./services/sorobanEventProcessor');

      const sorobanEventPoller = new SorobanEventPollerService({
        pollInterval: parseInt(process.env.SOROBAN_POLL_INTERVAL) || 30000,
        batchSize: parseInt(process.env.SOROBAN_BATCH_SIZE) || 100,
        contractAddresses: process.env.SOROBAN_CONTRACT_ADDRESSES ?
          process.env.SOROBAN_CONTRACT_ADDRESSES.split(',') : []
      });

      const sorobanEventProcessor = new SorobanEventProcessor({
        batchSize: parseInt(process.env.SOROBAN_PROCESSOR_BATCH_SIZE) || 50,
        processingDelay: parseInt(process.env.SOROBAN_PROCESSOR_DELAY) || 1000
      });

      // Start both services
      await sorobanEventPoller.start();
      await sorobanEventProcessor.startProcessing();

      console.log("Soroban Event Poller and Processor services started successfully.");

      // Store services globally for access in routes
      global.sorobanEventPoller = sorobanEventPoller;
      global.sorobanEventProcessor = sorobanEventProcessor;
    } catch (sorobanError) {
      console.error("Failed to initialize Soroban Event services:", sorobanError);
      console.log("Continuing without Soroban event indexing...");
    }
  })();

  // Start Secret Rotation Job
  try {
    const secretRotationJob = new SecretRotationJob();
    secretRotationJob.start();
  } catch (jobError) {
    console.error("Failed to initialize Secret Rotation Job:", jobError);
  }

  // Start Capacity Metrics Collector
  try {
    const CapacityMetricsCollector = require('./services/capacityMetricsCollector');
    const collector = new CapacityMetricsCollector();
    collector.start(parseInt(process.env.CAPACITY_COLLECTION_INTERVAL_MS) || 60000);
    console.log('Capacity Metrics Collector started successfully.');
  } catch (collectorError) {
    console.error("Failed to initialize Capacity Metrics Collector:", collectorError);
  }

  // Start KYC expiration worker
  console.log('Starting KYC expiration monitoring worker...');
  kycExpirationWorker.start();

  // Start GDPR compliance job
  console.log('Starting GDPR compliance monitoring job...');
  const gdprJob = new gdprComplianceJob();
  gdprJob.start();

  // Start Historical Price Tracking Job (SEP-40)
  console.log('Starting Historical Price Tracking Job...');
  historicalPriceTrackingJob.start();

  startServer();
}

module.exports = { app, startServer };