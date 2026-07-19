# Configuration Management Architecture

Lumina Backend now uses a process-local `ConfigManager` for runtime configuration.
The manager loads `config/runtime-config.json` or the `RUNTIME_CONFIG_PATH` override,
applies typed defaults, validates every field against the schema, and atomically swaps
in only valid configurations.

## Design

- **Schema-first validation:** `backend/src/config/schema.js` defines allowed sections,
  types, enum values, defaults, and numeric bounds.
- **Hot reload:** `fs.watch` monitors the containing directory and debounces reloads so
  updates are visible without process restarts.
- **Safety:** invalid reloads are rejected, the previous known-good config remains active,
  and a `reloadFailed` event is emitted for alerting.
- **Performance:** reads use immutable in-memory state; no request path performs disk I/O,
  preserving the <100ms P99 critical-path target.
- **Security:** runtime config is non-secret. Secrets continue to use the existing secrets
  service and environment-specific secret stores.

## Deployment

Roll out schema changes with blue-green deployments. Send 5% canary traffic to the green
pool, verify `config_reloads_total{status="failure"}` remains flat, then promote green.
