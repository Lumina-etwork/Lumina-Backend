# HashiCorp Vault Configuration for Vesting Vault Backend

ui = true

# Storage backend - can be file, consul, or other backends
storage "file" {
  path = "./vault-data"
}

# HTTP listener configuration
listener "tcp" {
  address = "0.0.0.0:8200"
  tls_disable = 1
}

# API address for clients
api_addr = "http://localhost:8200"

# Cluster address for HA setup (optional)
cluster_addr = "http://localhost:8201"

# Default lease TTL
default_lease_ttl = "168h"

# Maximum lease TTL
max_lease_ttl = "720h"

# Enable audit logging
disable_mlock = true

# Log level
log_level = "info"
