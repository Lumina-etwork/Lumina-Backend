#!/bin/bash

# HashiCorp Vault Setup Script for Vesting Vault Backend

set -e

echo "Setting up HashiCorp Vault for Vesting Vault Backend..."

# Check if Vault is installed
if ! command -v vault &> /dev/null; then
    echo "Vault is not installed. Please install Vault first:"
    echo "  - macOS: brew install vault"
    echo "  - Ubuntu/Debian: sudo apt-get install vault"
    echo "  - Or download from: https://www.vaultproject.io/downloads"
    exit 1
fi

# Start Vault server in development mode
echo "Starting Vault server in development mode..."
vault server -config=./config/vault-config.hcl &
VAULT_PID=$!

# Wait for Vault to start
sleep 5

# Export Vault address
export VAULT_ADDR='http://localhost:8200'

# Initialize Vault (only for first time)
if [ ! -f "./vault-data/vault-init.json" ]; then
    echo "Initializing Vault..."
    vault operator init > ./vault-data/vault-init.json
    
    echo "Vault initialized. Save these keys safely:"
    cat ./vault-data/vault-init.json
fi

# Unseal Vault
echo "Unsealing Vault..."
UNSEAL_KEYS=$(grep "Unseal Key" ./vault-data/vault-init.json | cut -d'"' -f4)
for key in $UNSEAL_KEYS; do
    vault operator unseal $key
done

# Login with root token
ROOT_TOKEN=$(grep "Initial Root Token" ./vault-data/vault-init.json | cut -d'"' -f4)
vault login $ROOT_TOKEN

# Enable KV secrets engine
echo "Enabling KV secrets engine..."
vault secrets enable -path=secret kv-v2

# Create secrets for Vesting Vault
echo "Creating secrets for Vesting Vault..."

# Database secrets
vault kv put secret/vesting-vault/database \
    host="localhost" \
    port="6432" \
    username="postgres" \
    password="password" \
    name="vesting_vault" \
    ssl="false" \
    pool_max="20" \
    pool_min="5" \
    idle_timeout="30000" \
    connection_timeout="2000"

# Application secrets
vault kv put secret/vesting-vault/application \
    node_env="development" \
    port="3000" \
    jwt_secret="your-jwt-secret-key" \
    admin_signature_required="true"

# Stellar configuration
vault kv put secret/vesting-vault/stellar \
    horizon_primary="https://horizon.stellar.org" \
    horizon_fallback="https://horizon-testnet.stellar.org" \
    soroban_rpc="https://soroban-rpc.stellar.org"

# Create Vault policy for the application
echo "Creating Vault policy..."
cat > ./config/vesting-vault-policy.hcl << EOF
path "secret/data/vesting-vault/*" {
  capabilities = ["read"]
}
EOF

vault policy write vesting-vault ./config/vesting-vault-policy.hcl

# Create application token
echo "Creating application token..."
vault token create -policy=vesting-vault -ttl=24h > ./vault-data/app-token.txt

echo "Vault setup completed!"
echo "Application token saved to ./vault-data/app-token.txt"
echo "Vault server PID: $VAULT_PID"
echo "To stop Vault server: kill $VAULT_PID"
