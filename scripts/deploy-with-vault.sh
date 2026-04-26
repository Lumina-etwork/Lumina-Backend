#!/bin/bash

# Deployment script for Vesting Vault with HashiCorp Vault integration

set -e

echo "🚀 Deploying Vesting Vault with Vault secrets management..."

# Check if Vault token is provided
if [ -z "$VAULT_TOKEN" ]; then
    echo "❌ Error: VAULT_TOKEN environment variable is required"
    echo "Please set your Vault token: export VAULT_TOKEN=your-token-here"
    exit 1
fi

# Create necessary directories
mkdir -p vault-data
mkdir -p logs

# Start the services with Vault integration
echo "📦 Starting services with Docker Compose..."
docker-compose -f docker-compose.vault.yml up -d

# Wait for Vault to be ready
echo "⏳ Waiting for Vault to be ready..."
sleep 30

# Check Vault health
echo "🔍 Checking Vault health..."
docker exec vesting-vault-vault vault status

# Initialize Vault if not already initialized
if ! docker exec vesting-vault-vault vault status | grep -q "Initialized.*true"; then
    echo "🔐 Initializing Vault..."
    docker exec vesting-vault-vault vault operator init > vault-data/vault-init.txt
    
    echo "📋 Vault initialization complete. Save these keys safely:"
    cat vault-data/vault-init.txt
    
    # Unseal Vault
    echo "🔓 Unsealing Vault..."
    UNSEAL_KEYS=$(grep "Unseal Key" vault-data/vault-init.txt | cut -d'"' -f4)
    for key in $UNSEAL_KEYS; do
        docker exec vesting-vault-vault vault operator unseal $key
    done
    
    # Login with root token
    ROOT_TOKEN=$(grep "Initial Root Token" vault-data/vault-init.txt | cut -d'"' -f4)
    docker exec -e VAULT_TOKEN="$ROOT_TOKEN" vesting-vault-vault vault login $ROOT_TOKEN
    
    # Enable KV secrets engine
    docker exec -e VAULT_TOKEN="$ROOT_TOKEN" vesting-vault-vault vault secrets enable -path=secret kv-v2
    
    # Create secrets
    echo "📝 Creating application secrets in Vault..."
    
    # Database secrets
    docker exec -e VAULT_TOKEN="$ROOT_TOKEN" vesting-vault-vault vault kv put secret/vesting-vault/database \
        host="pgbouncer" \
        port="5432" \
        username="postgres" \
        password="password" \
        name="vesting_vault" \
        ssl="false" \
        pool_max="20" \
        pool_min="5" \
        idle_timeout="30000" \
        connection_timeout="2000"
    
    # Application secrets
    docker exec -e VAULT_TOKEN="$ROOT_TOKEN" vesting-vault-vault vault kv put secret/vesting-vault/application \
        node_env="production" \
        port="3000" \
        jwt_secret="your-production-jwt-secret-key" \
        admin_signature_required="true"
    
    # Stellar configuration
    docker exec -e VAULT_TOKEN="$ROOT_TOKEN" vesting-vault-vault vault kv put secret/vesting-vault/stellar \
        horizon_primary="https://horizon.stellar.org" \
        horizon_fallback="https://horizon-testnet.stellar.org" \
        soroban_rpc="https://soroban-rpc.stellar.org"
    
    # Create policy for application
    echo "📋 Creating Vault policy for application..."
    docker exec -e VAULT_TOKEN="$ROOT_TOKEN" vesting-vault-vault sh -c 'cat > /tmp/policy.hcl << EOF
path "secret/data/vesting-vault/*" {
  capabilities = ["read"]
}
EOF'
    
    docker exec -e VAULT_TOKEN="$ROOT_TOKEN" vesting-vault-vault vault policy write vesting-vault /tmp/policy.hcl
    
    # Create application token
    echo "🎫 Creating application token..."
    docker exec -e VAULT_TOKEN="$ROOT_TOKEN" vesting-vault-vault vault token create -policy="vesting-vault" -ttl="24h" > vault-data/app-token.txt
    
    echo "✅ Vault setup completed!"
    echo "🎫 Application token saved to vault-data/app-token.txt"
else
    echo "✅ Vault is already initialized"
fi

# Wait for backend to be ready
echo "⏳ Waiting for backend service to be ready..."
sleep 30

# Check backend health
echo "🔍 Checking backend health..."
curl -f http://localhost:3000/health || {
    echo "❌ Backend health check failed"
    docker-compose -f docker-compose.vault.yml logs backend
    exit 1
}

echo "✅ Deployment completed successfully!"
echo "🌐 Application is running at: http://localhost:3000"
echo "🔐 Vault UI is available at: http://localhost:8200"
echo "📊 View logs with: docker-compose -f docker-compose.vault.yml logs -f"

# Show service status
echo ""
echo "📊 Service Status:"
docker-compose -f docker-compose.vault.yml ps
