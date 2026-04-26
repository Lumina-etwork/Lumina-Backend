# HashiCorp Vault Integration for Vesting Vault Backend

## Overview

This document describes the integration of HashiCorp Vault for secure secrets management in the Vesting Vault backend application. This implementation replaces all `.env` files containing production secrets with dynamic fetching from Vault at runtime.

## Architecture

### Before Vault Integration
- Environment variables stored in `.env` files
- Hardcoded secrets in configuration files
- Risk of secrets exposure in version control
- No centralized secrets management

### After Vault Integration
- All secrets stored securely in HashiCorp Vault
- Dynamic secret fetching at application startup
- Centralized secrets management with audit logs
- No secrets in code or configuration files

## Components

### 1. Vault Configuration (`config/vault-config.hcl`)
- Vault server configuration for development
- File-based storage backend
- HTTP listener on port 8200
- KV v2 secrets engine enabled

### 2. Vault Client (`config/vault.js`)
- Node.js Vault client implementation
- Automatic retry mechanism
- Connection health checks
- Structured secret management

### 3. Setup Scripts
- `scripts/setup-vault.sh` - Unix/Linux setup
- `scripts/setup-vault.ps1` - Windows PowerShell setup
- `scripts/deploy-with-vault.sh` - Production deployment

### 4. Docker Configuration
- `docker-compose.vault.yml` - Complete stack with Vault
- Updated Dockerfile with Vault dependencies
- Removed all environment variables from containers

## Secret Structure

### Database Secrets (`secret/vesting-vault/database`)
```
host: "pgbouncer"
port: "5432"
username: "postgres"
password: "password"
name: "vesting_vault"
ssl: "false"
pool_max: "20"
pool_min: "5"
idle_timeout: "30000"
connection_timeout: "2000"
```

### Application Secrets (`secret/vesting-vault/application`)
```
node_env: "production"
port: "3000"
jwt_secret: "your-production-jwt-secret-key"
admin_signature_required: "true"
```

### Stellar Configuration (`secret/vesting-vault/stellar`)
```
horizon_primary: "https://horizon.stellar.org"
horizon_fallback: "https://horizon-testnet.stellar.org"
soroban_rpc: "https://soroban-rpc.stellar.org"
```

## Security Features

### 1. Authentication
- Token-based authentication
- Time-limited tokens (24h TTL)
- Role-based access control

### 2. Audit Logging
- All secret access logged
- Failed authentication attempts tracked
- Request/response auditing

### 3. Network Security
- TLS encryption in production
- Network segmentation
- Firewall rules for Vault access

### 4. Secret Rotation
- Automatic token renewal
- Secret rotation capabilities
- Graceful handling of expired tokens

## Deployment

### Development Setup

1. **Install Vault**:
   ```bash
   # macOS
   brew install vault
   
   # Ubuntu/Debian
   sudo apt-get install vault
   
   # Windows
   choco install vault
   ```

2. **Setup Vault**:
   ```bash
   # Unix/Linux
   ./scripts/setup-vault.sh
   
   # Windows PowerShell
   .\scripts\setup-vault.ps1
   ```

3. **Start Application**:
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

## Migration from .env Files

### Files Modified
- `config/database.js` - Uses Vault secrets for database config
- `backend/src/database/connection.js` - Vault integration for Sequelize
- `backend/src/index.js` - Vault initialization in startup
- `index.js` - Main application with Vault
- `services/stellarService.js` - Stellar config from Vault

### Files Removed
- All `.env` files from production deployment
- Environment variables from Docker containers
- Hardcoded secrets from configuration

### Environment Variables Still Used
- `VAULT_ADDR` - Vault server address
- `VAULT_TOKEN` - Vault authentication token
- `NODE_ENV` - Environment mode (development/test/production)

## Monitoring and Health Checks

### Vault Health
```bash
# Check Vault status
curl http://localhost:8200/v1/sys/health

# Check application Vault integration
curl http://localhost:3000/health/vault
```

### Application Health
```bash
# General health check
curl http://localhost:3000/health

# Database health with Vault
curl http://localhost:3000/health/db
```

## Troubleshooting

### Common Issues

1. **Vault Connection Failed**:
   - Check Vault server is running
   - Verify VAULT_ADDR environment variable
   - Check network connectivity

2. **Authentication Failed**:
   - Verify VAULT_TOKEN is valid
   - Check token hasn't expired
   - Verify policy permissions

3. **Secret Not Found**:
   - Check secret path in Vault
   - Verify policy allows access
   - Check secret exists in correct path

### Debug Commands

```bash
# Check Vault logs
docker logs vesting-vault-vault

# Check application logs
docker logs vesting-vault-backend

# Test Vault connection
docker exec vesting-vault-vault vault status

# List secrets in Vault
docker exec -e VAULT_TOKEN=$VAULT_TOKEN vesting-vault-vault vault kv list secret/
```

## Best Practices

### 1. Secret Management
- Use different tokens for different environments
- Implement secret rotation policies
- Regularly audit secret access

### 2. Security
- Enable TLS in production
- Use short-lived tokens
- Implement proper network segmentation

### 3. Monitoring
- Monitor Vault health metrics
- Set up alerts for failed authentications
- Track secret access patterns

### 4. Backup and Recovery
- Regular Vault data backups
- Document recovery procedures
- Test disaster recovery scenarios

## Future Enhancements

1. **Dynamic Secrets**: Implement database credentials rotation
2. **Secrets Engine**: Add integration with cloud providers
3. **Auto-unseal**: Configure automatic unsealing with KMS
4. **Replication**: Set up Vault replication for high availability
5. **Monitoring**: Enhanced metrics and alerting

## Support

For issues related to Vault integration:
1. Check the troubleshooting section
2. Review Vault and application logs
3. Verify network connectivity
4. Validate token permissions

For general application issues, refer to the main application documentation.
