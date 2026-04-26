# HashiCorp Vault Setup Script for Vesting Vault Backend (PowerShell)

param(
    [string]$VaultPath = "vault",
    [string]$ConfigPath = ".\config\vault-config.hcl",
    [string]$DataPath = ".\vault-data"
)

Write-Host "Setting up HashiCorp Vault for Vesting Vault Backend..." -ForegroundColor Green

# Check if Vault is installed
try {
    & $VaultPath version
} catch {
    Write-Host "Vault is not installed. Please install Vault first:" -ForegroundColor Red
    Write-Host "  - Download from: https://www.vaultproject.io/downloads" -ForegroundColor Yellow
    Write-Host "  - Or use Chocolatey: choco install vault" -ForegroundColor Yellow
    exit 1
}

# Create vault-data directory if it doesn't exist
if (!(Test-Path $DataPath)) {
    New-Item -ItemType Directory -Path $DataPath -Force
}

# Start Vault server in development mode
Write-Host "Starting Vault server..." -ForegroundColor Blue
$VaultProcess = Start-Process -FilePath $VaultPath -ArgumentList "server -config $ConfigPath" -PassThru -WindowStyle Hidden

# Wait for Vault to start
Start-Sleep -Seconds 5

# Set Vault address
$env:VAULT_ADDR = "http://localhost:8200"

# Check if Vault is already initialized
$InitFile = Join-Path $DataPath "vault-init.json"
if (!(Test-Path $InitFile)) {
    Write-Host "Initializing Vault..." -ForegroundColor Blue
    $InitOutput = & $VaultPath operator init
    $InitOutput | Out-File -FilePath $InitFile
    
    Write-Host "Vault initialized. Save these keys safely:" -ForegroundColor Yellow
    Write-Host $InitOutput
}

# Extract unseal keys and root token
$InitContent = Get-Content $InitFile
$UnsealKeys = $InitContent | Where-Object { $_ -match "Unseal Key" } | ForEach-Object { ($_ -split '"')[4] }
$RootToken = ($InitContent | Where-Object { $_ -match "Initial Root Token" } | ForEach-Object { ($_ -split '"')[4] })[0]

# Unseal Vault
Write-Host "Unsealing Vault..." -ForegroundColor Blue
foreach ($key in $UnsealKeys) {
    & $VaultPath operator unseal $key
}

# Login with root token
& $VaultPath login $RootToken

# Enable KV secrets engine
Write-Host "Enabling KV secrets engine..." -ForegroundColor Blue
& $VaultPath secrets enable -path=secret kv-v2

# Create secrets for Vesting Vault
Write-Host "Creating secrets for Vesting Vault..." -ForegroundColor Blue

# Database secrets
& $VaultPath kv put secret/vesting-vault/database `
    host="localhost" `
    port="6432" `
    username="postgres" `
    password="password" `
    name="vesting_vault" `
    ssl="false" `
    pool_max="20" `
    pool_min="5" `
    idle_timeout="30000" `
    connection_timeout="2000"

# Application secrets
& $VaultPath kv put secret/vesting-vault/application `
    node_env="development" `
    port="3000" `
    jwt_secret="your-jwt-secret-key" `
    admin_signature_required="true"

# Stellar configuration
& $VaultPath kv put secret/vesting-vault/stellar `
    horizon_primary="https://horizon.stellar.org" `
    horizon_fallback="https://horizon-testnet.stellar.org" `
    soroban_rpc="https://soroban-rpc.stellar.org"

# Create Vault policy for the application
Write-Host "Creating Vault policy..." -ForegroundColor Blue
$PolicyContent = @"
path "secret/data/vesting-vault/*" {
  capabilities = ["read"]
}
"@
$PolicyContent | Out-File -FilePath ".\config\vesting-vault-policy.hcl"

& $VaultPath policy write vesting-vault .\config\vesting-vault-policy.hcl

# Create application token
Write-Host "Creating application token..." -ForegroundColor Blue
$TokenOutput = & $VaultPath token create -policy="vesting-vault" -ttl="24h"
$TokenOutput | Out-File -FilePath ".\vault-data\app-token.txt"

Write-Host "Vault setup completed!" -ForegroundColor Green
Write-Host "Application token saved to .\vault-data\app-token.txt" -ForegroundColor Green
Write-Host "Vault server PID: $($VaultProcess.Id)" -ForegroundColor Green
Write-Host "To stop Vault server: Stop-Process -Id $($VaultProcess.Id)" -ForegroundColor Yellow
