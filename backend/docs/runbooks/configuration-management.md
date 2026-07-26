# Configuration Management Runbook

## Reload a configuration

1. Edit the JSON file referenced by `RUNTIME_CONFIG_PATH` or `config/runtime-config.json`.
2. Validate the JSON syntax locally.
3. Save the file. The backend watches the directory and hot-reloads automatically.
4. Check `/api/config/status` and Prometheus metric `config_version`.

## Alert response

- Alert: `ConfigReloadFailuresHigh`
- Query: `increase(config_reloads_total{status="failure"}[5m]) > 0`
- Action: inspect app logs for `ConfigurationValidationError`, revert the bad file,
  and confirm the previous known-good config stayed active.

## Blue-green and canary

Deploy schema/code updates to green first, shift 5% traffic for 15 minutes, compare API
latency and config reload failures, then shift 100% if healthy.
