# Vesting Vault Backend - Vault Integration

## 🚀 Overview

This branch implements HashiCorp Vault integration for secure secrets management, replacing all `.env` files containing production secrets with dynamic fetching from Vault at runtime.

## 🔐 Security Improvements

- **Removed all .env files** from production deployment
- **Centralized secrets management** with HashiCorp Vault
- **Dynamic secret fetching** at application startup
- **Audit logging** for all secret access
- **Token-based authentication** with time-limited access
- **Role-based access control** for different environments

## 📁 New Files Added

### Configuration
- `config/vault-config.hcl` - Vault server configuration
- `config/vault.js` - Node.js Vault client implementation

### Scripts
- `scripts/setup-vault.sh` - Unix/Linux Vault setup script
- `scripts/setup-vault.ps1` - Windows PowerShell Vault setup script
- `scripts/deploy-with-vault.sh` - Production deployment script

### Documentation
- `VAULT_INTEGRATION.md` - Comprehensive integration documentation
- `README_VAULT.md` - This file

### Docker
- `docker-compose.vault.yml` - Complete stack with Vault integration

### Tests
- `tests/vault-integration.test.js` - Vault integration tests

## 🔄 Files Modified

### Backend Configuration
- `config/database.js` - Uses Vault secrets for database configuration
- `backend/src/database/connection.js` - Vault integration for Sequelize
- `backend/src/index.js` - Vault initialization in startup sequence
- `index.js` - Main application with Vault integration
- `services/stellarService.js` - Stellar configuration from Vault

### Docker
- `backend/Dockerfile` - Updated to include Vault dependencies

## 🚀 Quick Start

### Prerequisites
- Docker and Docker Compose
- Node.js 18+
- HashiCorp Vault (optional for local development)

### Development Setup

1. **Setup Vault**:
   ```bash
   # Unix/Linux
   ./scripts/setup-vault.sh
   
   # Windows PowerShell
   .\scripts\setup-vault.ps1
   ```

2. **Start Application**:
   ```bash
   npm start
   ```

### Production Deployment

1. **Deploy with Docker Compose**:
   ```bash
   export VAULT_TOKEN=your-production-token
   ./scripts/deploy-with-vault.sh
   ```

2. **Manual Deployment**:
   ```bash
   docker-compose -f docker-compose.vault.yml up -d
   ```

## 🔧 Configuration

### Environment Variables Required
- `VAULT_ADDR` - Vault server address (default: http://localhost:8200)
- `VAULT_TOKEN` - Vault authentication token
- `NODE_ENV` - Environment mode (development/test/production)

### Vault Secret Structure

#### Database (`secret/vesting-vault/database`)
- `host` - Database host
- `port` - Database port
- `username` - Database username
- `password` - Database password
- `name` - Database name
- `ssl` - SSL configuration
- `pool_max` - Maximum pool connections
- `pool_min` - Minimum pool connections
- `idle_timeout` - Idle timeout
- `connection_timeout` - Connection timeout

#### Application (`secret/vesting-vault/application`)
- `node_env` - Node environment
- `port` - Application port
- `jwt_secret` - JWT secret key
- `admin_signature_required` - Admin signature requirement

#### Stellar (`secret/vesting-vault/stellar`)
- `horizon_primary` - Primary Horizon endpoint
- `horizon_fallback` - Fallback Horizon endpoint
- `soroban_rpc` - Soroban RPC endpoint

## 🏥 Health Checks

### Application Health
```bash
curl http://localhost:3000/health
```

### Database Health
```bash
curl http://localhost:3000/health/db
```

### Vault Health
```bash
curl http://localhost:8200/v1/sys/health
```

## 🧪 Testing

### Run Tests
```bash
npm test
```

### Run Vault Integration Tests
```bash
npm test -- tests/vault-integration.test.js
```

## 🔍 Monitoring

### Application Logs
```bash
docker logs vesting-vault-backend
```

### Vault Logs
```bash
docker logs vesting-vault-vault
```

### Database Logs
```bash
docker logs vesting-vault-db
```

## 🛠️ Troubleshooting

### Common Issues

1. **Vault Connection Failed**:
   - Check Vault server is running
   - Verify VAULT_ADDR environment variable
   - Check network connectivity

2. **Authentication Failed**:
   - Verify VAULT_TOKEN is valid
   - Check token hasn't expired
   - Verify policy permissions

3. **Application Won't Start**:
   - Check Vault is initialized
   - Verify secrets exist in Vault
   - Check application logs

### Debug Commands

```bash
# Check Vault status
docker exec vesting-vault-vault vault status

# Check application logs
docker logs vesting-vault-backend

# Test Vault connection
curl http://localhost:8200/v1/sys/health

# List secrets in Vault
docker exec -e VAULT_TOKEN=$VAULT_TOKEN vesting-vault-vault vault kv list secret/
```

## 📊 Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Application   │    │   HashiCorp      │    │   Database     │
│   (Node.js)     │───▶│   Vault         │───▶│   PostgreSQL   │
│                 │    │                  │    │                 │
│ - Dynamic       │    │ - Secrets Store  │    │ - Data Store   │
│   Secrets       │    │ - Audit Logs     │    │                 │
│ - Health Checks │    │ - Token Auth     │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

## 🔐 Security Features

### Authentication
- Token-based authentication
- Time-limited tokens (24h TTL)
- Role-based access control

### Audit & Logging
- All secret access logged
- Failed authentication attempts tracked
- Request/response auditing

### Network Security
- TLS encryption in production
- Network segmentation
- Firewall rules for Vault access

## 🚀 Performance Benefits

- **Faster startup** - No .env file parsing
- **Better caching** - Vault client with built-in caching
- **Connection pooling** - Optimized database connections
- **Health monitoring** - Real-time health checks

## 📈 Migration Benefits

### Before
- ❌ Secrets in .env files
- ❌ Risk of exposure in version control
- ❌ No audit trail
- ❌ Manual secret rotation

### After
- ✅ Secure Vault storage
- ✅ Centralized management
- ✅ Complete audit trail
- ✅ Automated rotation

## 🤝 Contributing

When contributing to this branch:

1. Never commit secrets to version control
2. Use Vault for all new secrets
3. Update documentation for new secret paths
4. Add tests for new Vault integrations

## 📚 Documentation

- [Vault Integration Guide](./VAULT_INTEGRATION.md) - Comprehensive documentation
- [HashiCorp Vault Docs](https://www.vaultproject.io/docs) - Official Vault documentation
- [Node.js Vault Client](https://github.com/hashicorp/vault-node) - Client library docs

## 🆘 Support

For issues related to Vault integration:
1. Check the troubleshooting section
2. Review Vault and application logs
3. Verify network connectivity
4. Validate token permissions

## 🎯 Next Steps

1. **Dynamic Secrets**: Implement database credentials rotation
2. **Auto-unseal**: Configure automatic unsealing with KMS
3. **Replication**: Set up Vault replication for HA
4. **Monitoring**: Enhanced metrics and alerting

---

**Note**: This branch removes all `.env` dependencies and implements a production-ready secrets management solution using HashiCorp Vault.
