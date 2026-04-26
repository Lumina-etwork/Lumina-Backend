# Vesting Vault Backend

A secure and scalable backend API for the Vesting Vault smart contract, featuring PostgreSQL connection pooling with PgBouncer, Stellar Horizon fallback mechanisms, and cryptographic payload signature verification.

## Features

### ✅ Issue #248: PostgreSQL Connection Pooling (PgBouncer Integration)
- Configured TypeORM with PgBouncer for efficient connection pooling
- Environment-based configuration for different deployment scenarios
- Health check endpoints for monitoring database connectivity
- Automatic connection management with configurable pool settings

### ✅ Issue #250: Stellar Horizon Rate Limit Fallback
- Automatic fallback to secondary Horizon nodes on rate limits (429)
- Support for Soroban RPC as additional fallback option
- Exponential backoff retry mechanism
- Health monitoring for all Stellar endpoints

### ✅ Issue #256: API Payload Signature Verification
- Ed25519 cryptographic signature verification using Stellar wallets
- Timestamp-based replay attack prevention
- Rate limiting for sensitive admin operations
- Multi-sig member management with signature verification

### ✅ Issue #258: GitHub Actions CI/CD Pipeline
- Automated testing, linting, and security scanning
- Multi-platform Docker image building (amd64/arm64)
- Container registry integration (GitHub Container Registry)
- SBOM generation and vulnerability scanning

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL with PgBouncer
- Docker (optional)

### Installation

1. Clone the repository:
```bash
git clone https://github.com/akordavid373/backend.git
cd backend
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
```bash
cp .env.example .env
# Edit .env with your configuration
```

4. Start the application:
```bash
npm start
```

## Environment Configuration

Create a `.env` file with the following variables:

```env
# Database Configuration with PgBouncer
DB_HOST=localhost
DB_PORT=6432
DB_USERNAME=postgres
DB_PASSWORD=password
DB_NAME=vesting_vault
DB_SSL=false

# Connection Pooling Settings
DB_POOL_MAX=20
DB_POOL_MIN=5
DB_IDLE_TIMEOUT=30000
DB_CONNECTION_TIMEOUT=2000

# Application Settings
NODE_ENV=development
PORT=3000

# Stellar Configuration
STELLAR_HORIZON_PRIMARY=https://horizon.stellar.org
STELLAR_HORIZON_FALLBACK=https://horizon-testnet.stellar.org
STELLAR_SOROBAN_RPC=https://soroban-rpc.stellar.org

# Security
JWT_SECRET=your-jwt-secret-key
ADMIN_SIGNATURE_REQUIRED=true
ADMIN_PUBLIC_KEYS=your-admin-public-key-1,your-admin-public-key-2
```

## API Endpoints

### Health Checks
- `GET /` - Application status
- `GET /health/db` - Database connectivity status

### Admin Endpoints (Require Signature Verification)
All admin endpoints require cryptographic signature verification:

- `POST /api/admin/multisig/add-member` - Add multi-sig member
- `POST /api/admin/multisig/remove-member` - Remove multi-sig member
- `POST /api/admin/vesting/update-schedule` - Update vesting schedule
- `POST /api/admin/emergency/pause` - Emergency pause
- `GET /api/admin/status` - Admin status and endpoint health

## Signature Verification

For sensitive admin operations, requests must include these headers:

- `x-stellar-signature`: Hex-encoded Ed25519 signature
- `x-stellar-public-key`: Stellar public key of the signer
- `x-timestamp`: Unix timestamp (must be within 5 minutes)

### Example Request

```javascript
const crypto = require('crypto');
const { Keypair } = require('stellar-sdk');

const payload = { accountId: 'GD5...', weight: 1 };
const timestamp = Date.now().toString();
const message = `${timestamp}.${JSON.stringify(payload)}`;
const messageHash = crypto.createHash('sha256').update(message).digest();

const keypair = Keypair.fromSecret('your-private-key');
const signature = keypair.sign(messageHash);

fetch('/api/admin/multisig/add-member', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-stellar-signature': signature.toString('hex'),
    'x-stellar-public-key': keypair.publicKey(),
    'x-timestamp': timestamp
  },
  body: JSON.stringify(payload)
});
```

## Docker Deployment

### Build and Run
```bash
docker build -t vesting-backend .
docker run -p 3000:3000 --env-file .env vesting-backend
```

### Docker Compose
```yaml
version: '3.8'
services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DB_HOST=pgbouncer
    depends_on:
      - pgbouncer
      - postgres

  pgbouncer:
    image: pgbouncer/pgbouncer:latest
    environment:
      - DATABASES_HOST=postgres
      - DATABASES_PORT=5432
      - DATABASES_USER=postgres
      - DATABASES_PASSWORD=password
      - DATABASES_DBNAME=vesting_vault
    depends_on:
      - postgres

  postgres:
    image: postgres:15
    environment:
      - POSTGRES_DB=vesting_vault
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=password
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

## Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run linting
npm run lint

# Fix linting issues
npm run lint:fix
```

## CI/CD Pipeline

The GitHub Actions workflow includes:

1. **Testing**: Automated test execution with PostgreSQL
2. **Linting**: Code quality checks with ESLint
3. **Security Scanning**: Vulnerability scanning with Trivy
4. **Docker Build**: Multi-platform image building
5. **Registry Push**: Automatic push to GitHub Container Registry
6. **SBOM Generation**: Software Bill of Materials creation

## PgBouncer Configuration

Configure PgBouncer for optimal performance:

```ini
[databases]
vesting_vault = host=localhost port=5432 dbname=vesting_vault

[pgbouncer]
listen_port = 6432
listen_addr = 127.0.0.1
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt
logfile = /var/log/pgbouncer/pgbouncer.log
pidfile = /var/run/pgbouncer/pgbouncer.pid
admin_users = postgres
stats_users = stats, postgres

# Connection pooling settings
pool_mode = transaction
max_client_conn = 100
default_pool_size = 20
min_pool_size = 5
reserve_pool_size = 5
reserve_pool_timeout = 5
max_db_connections = 50
max_user_connections = 50

# Timeouts
server_reset_query = DISCARD ALL
server_check_delay = 30
server_check_query = select 1
server_lifetime = 3600
server_idle_timeout = 600
```

## Monitoring

### Health Endpoints
- Application health: `GET /`
- Database health: `GET /health/db`
- Admin status: `GET /api/admin/status` (requires auth)

### Metrics
The application provides structured logging for:
- Database connection pool status
- Stellar endpoint fallback events
- Signature verification attempts
- Rate limiting events

## Security Considerations

1. **Signature Verification**: All admin operations require valid Stellar signatures
2. **Replay Protection**: Timestamp validation prevents replay attacks
3. **Rate Limiting**: Sensitive operations are rate-limited per public key
4. **Connection Pooling**: PgBouncer prevents database connection exhaustion
5. **Environment Variables**: Sensitive data stored in environment variables
6. **Container Security**: Multi-stage builds and non-root user in Docker

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Run the test suite
6. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For issues and questions:
- Create an issue in the GitHub repository
- Check the health endpoints for system status
- Review logs for detailed error information
