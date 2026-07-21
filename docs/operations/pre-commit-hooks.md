# Pre-Commit Hook Suite

## Architecture

```
git commit → pre-commit hook → lint-staged → eslint + prettier + secretlint
                                        → (parallel) on staged files only

git commit → commit-msg hook → commitlint → validates conventional commit format

git push   → pre-push hook → cargo fmt --check (on .rs changes)
                           → (future: full type-check)
```

## Hook Stages

| Hook | Trigger | Tools | Target Latency |
|---|---|---|---|
| `pre-commit` | `git commit` | lint-staged (eslint --fix, prettier --write, secretlint) | <200ms |
| `commit-msg` | `git commit` | commitlint (conventional commit check) | <10ms |
| `pre-push` | `git push` | cargo fmt --check | <2s (Rust only) |

## Bypass Mechanisms

| Method | Command |
|---|---|
| Single bypass | `git commit --no-verify` |
| All hooks bypass | `HUSKY=0 git commit` |
| Disable entirely | `npx husky uninstall` |
| Re-enable | `npx husky` |

## Metrics & Monitoring

When `HOOK_METRICS_ENABLED=true` is set:

- Metrics written to `<tmpdir>/lumina-hook-metrics/hook-*.json`
- Optionally pushed to Prometheus Pushgateway via `PROMETHEUS_PUSHGATEWAY` env var
- Metrics: `pre_commit_duration_ms`, `commit_msg_duration_ms`, `pre_push_duration_ms`

### Prometheus Recording Rules (add to `alerts/slo-burn-rate-rules.yaml`)

```yaml
- record: lumina:pre_commit_duration_seconds:p99
  expr: histogram_quantile(0.99, sum by (le) (rate(pre_commit_duration_seconds_bucket[5m])))
  labels:
    window: fast

- alert: LuminaPreCommitDurationTooHigh
  expr: lumina:pre_commit_duration_seconds:p99{window="fast"} > 0.5
  for: 5m
  labels:
    severity: ticket
  annotations:
    summary: Pre-commit hook P99 duration exceeds 500ms threshold
```

## Grafana Dashboard Panel

Add to `dashboards/slo-burn-rate-dashboard.json`:

```json
{
  "title": "Pre-commit Hook Duration (P99)",
  "type": "graph",
  "targets": [{
    "expr": "lumina:pre_commit_duration_seconds:p99{window=\"fast\"}",
    "legendFormat": "P99"
  }],
  "yaxes": [{ "format": "s", "label": "Duration" }]
}
```

## Configuration Reference

| File | Purpose |
|---|---|
| `.husky/pre-commit` | Pre-commit hook - runs lint-staged |
| `.husky/commit-msg` | Commit message validation |
| `.husky/pre-push` | Pre-push checks (Rust fmt) |
| `eslint.config.js` | ESLint flat config for JS/TS |
| `.prettierrc.json` | Prettier formatting rules |
| `.commitlintrc.json` | Conventional commit config |
| `.secretlintrc.json` | Secret detection rules |
| `.lintstagedrc.json` | Staged file linting rules |
| `rustfmt.toml` | Rust formatting config |
| `deny.toml` | Rust dependency policy |

## Rollback Plan

1. **Emergency**: `git commit --no-verify` bypasses hooks per-commit
2. **Disable all hooks**: `npx husky uninstall` (restores git defaults)
3. **Revert configs**: `git checkout -- eslint.config.js .prettierrc.json .commitlintrc.json .secretlintrc.json .lintstagedrc.json rustfmt.toml deny.toml .husky/`
4. **Reinstall**: `npm install` (reverts package.json and package-lock.json)
