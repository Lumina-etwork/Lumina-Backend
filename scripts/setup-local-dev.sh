#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_INSTALL=false
SKIP_DOCKER=false
CHECK_ONLY=false

usage() {
  cat <<'USAGE'
Usage: scripts/setup-local-dev.sh [options]

Bootstraps a Lumina Backend workstation for local development.

Options:
  --check-only       Validate required tools and configuration without changing files.
  --skip-install    Do not run npm/cargo dependency installation.
  --skip-docker     Do not start Docker Compose services.
  -h, --help        Show this help message.

Environment variables:
  COMPOSE_FILE      Compose file to use (default: docker-compose.yml).
  NODE_ENV          Environment for local commands (default: development).
USAGE
}

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check-only) CHECK_ONLY=true ;;
    --skip-install) SKIP_INSTALL=true ;;
    --skip-docker) SKIP_DOCKER=true ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
  shift
done

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command '$1' was not found in PATH."
}

version_major() {
  "$1" --version | sed -E 's/[^0-9]*([0-9]+).*/\1/'
}

copy_if_missing() {
  local source="$1"
  local target="$2"
  if [[ ! -f "$source" ]]; then
    warn "Template $source does not exist; skipping $target."
    return
  fi
  if [[ -f "$target" ]]; then
    log "Keeping existing $target"
    return
  fi
  if [[ "$CHECK_ONLY" == true ]]; then
    warn "$target is missing and would be created from $source."
    return
  fi
  cp "$source" "$target"
  log "Created $target from $source"
}

install_node_dependencies() {
  local dir="$1"
  [[ -f "$dir/package.json" ]] || return

  if [[ -f "$dir/package-lock.json" ]]; then
    (cd "$dir" && npm ci)
  else
    (cd "$dir" && npm install)
  fi
}

log "Validating local development prerequisites"
require_command node
require_command npm
require_command git

node_major="$(version_major node)"
if (( node_major < 20 )); then
  fail "Node.js 20+ is required; found $(node --version)."
fi

if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    HAS_DOCKER_COMPOSE=true
  else
    HAS_DOCKER_COMPOSE=false
    warn "Docker is installed but 'docker compose' is unavailable."
  fi
else
  HAS_DOCKER_COMPOSE=false
  warn "Docker is not installed; use --skip-docker or install Docker to start local services."
fi

if command -v cargo >/dev/null 2>&1; then
  HAS_CARGO=true
else
  HAS_CARGO=false
  warn "Rust cargo was not found; Soroban/Rust contract dependencies will be skipped."
fi

log "Preparing environment files"
copy_if_missing "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
copy_if_missing "$ROOT_DIR/backend/.env.example" "$ROOT_DIR/backend/.env"

if [[ "$SKIP_INSTALL" == false ]]; then
  if [[ "$CHECK_ONLY" == true ]]; then
    log "Dependency installation would run for root package and backend package."
  else
    log "Installing root Node.js dependencies"
    install_node_dependencies "$ROOT_DIR"

    log "Installing backend Node.js dependencies"
    install_node_dependencies "$ROOT_DIR/backend"

    if [[ "$HAS_CARGO" == true && -f "$ROOT_DIR/contracts/Cargo.toml" ]]; then
      log "Fetching Rust contract dependencies"
      (cd "$ROOT_DIR/contracts" && cargo fetch)
    fi
  fi
else
  log "Skipping dependency installation"
fi

if [[ "$SKIP_DOCKER" == false ]]; then
  if [[ "$HAS_DOCKER_COMPOSE" == true ]]; then
    if [[ "$CHECK_ONLY" == true ]]; then
      log "Docker Compose services would be started with ${COMPOSE_FILE:-docker-compose.yml}."
    else
      log "Starting local infrastructure with Docker Compose"
      compose_services="$(cd "$ROOT_DIR" && docker compose -f "${COMPOSE_FILE:-docker-compose.yml}" config --services)"
      db_service=""
      if printf '%s\n' "$compose_services" | grep -qx 'postgres'; then
        db_service="postgres"
      elif printf '%s\n' "$compose_services" | grep -qx 'db'; then
        db_service="db"
      fi

      services_to_start=()
      [[ -n "$db_service" ]] && services_to_start+=("$db_service")
      if printf '%s\n' "$compose_services" | grep -qx 'redis'; then
        services_to_start+=("redis")
      fi

      if [[ ${#services_to_start[@]} -eq 0 ]]; then
        warn "No postgres/db or redis services found in ${COMPOSE_FILE:-docker-compose.yml}; skipping Docker Compose startup."
      else
        (cd "$ROOT_DIR" && docker compose -f "${COMPOSE_FILE:-docker-compose.yml}" up -d "${services_to_start[@]}")
      fi
    fi
  else
    warn "Skipping Docker Compose startup because Docker Compose is unavailable."
  fi
else
  log "Skipping Docker Compose startup"
fi

if [[ "$CHECK_ONLY" == false ]]; then
  log "Running database migrations"
  (cd "$ROOT_DIR" && NODE_ENV="${NODE_ENV:-development}" npm run migrate)
fi

log "Local development setup completed"
cat <<NEXT_STEPS

Next steps:
  1. Review .env and backend/.env for local credentials and service endpoints.
  2. Run 'npm run dev' from the repository root for the API service.
  3. Run 'npm run dev' from backend/ for the vesting backend service when needed.
NEXT_STEPS
