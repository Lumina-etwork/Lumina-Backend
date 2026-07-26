# GitHub Actions Workflow Optimization

## Architecture

The optimized CI workflow is organized as a fan-out/fan-in pipeline:

1. **Change detection** uses path filters to determine which service areas changed.
2. **Parallel validation jobs** run independently for root Node services, backend Node services, Rust crates, infrastructure manifests, and security gates.
3. **Performance smoke testing** runs after functional test jobs and enforces the critical-path P99 target with `--p99-threshold-ms=100`.
4. **CI summary** fans results back in and fails only on failed or cancelled jobs, allowing intentionally skipped jobs for unchanged areas.

This design reduces queue time by avoiding unrelated test suites and reduces wall-clock time by running service-specific checks in parallel.

## Availability and deployment alignment

The workflow validates the existing blue-green Kubernetes deployment assets before merge. Production rollout remains delegated to the blue-green deployment controller and runbooks, which allows canary analysis and rollback without blocking CI capacity.

## Security review gates

Security checks run in parallel with service tests and include:

- `npm audit --audit-level=high` for root dependencies.
- `npm audit --audit-level=high` for backend dependencies.
- `cargo audit` for Rust dependency manifests.
- CodeQL JavaScript/TypeScript analysis.

## Docker Image Layer Caching

The pipeline uses Docker BuildKit with GitHub Actions cache backend (`type=gha`) for layer caching.

### Architecture

```
Source change → docker-build job
                  │
                  ├─ Check cache (type=gha, scope=docker-backend)
                  │     │
                  │     ├─ HIT  → reuse cached layers (~90s)
                  │     └─ MISS → build from scratch (~5 min)
                  │
                  └─ Push to ghcr.io with git SHA tag
                        │
                        └─ blue-green-deploy job (main only)
                              │
                              ├─ Canary stages: 10% → 25% → 50% → 100%
                              ├─ Error rate monitoring (auto-rollback >1%)
                              └─ Traffic switch to green
```

### Cache keys

The `docker-build` job uses scoped caches per service:

| Service | Cache Scope | Invalidation |
|---------|------------|--------------|
| Backend | `docker-backend` | `package-lock.json` change |
| Health-monitor | `docker-health-monitor` | `package.json` change |

Cache is automatically saved on `main` builds and restored on PR branches. Cache mode is `max` (all layers, not just final image).

### Dockerfile optimizations

Both Dockerfiles follow these practices:

1. **Multi-stage**: `builder` stage separates dependency installation from runtime
2. **Base image pinning**: `node:20-alpine@sha256:...` prevents unexpected base image drift
3. **Layer ordering**: package files copied first, npm ci second, source last
4. **BuildKit cache mounts**: `RUN --mount=type=cache,target=/root/.npm` persists the npm cache across builds
5. **Minimal layers**: `addgroup`/`adduser`/`chown` combined into single `RUN`

### Expected build time reduction

| Metric | Before | After |
|--------|--------|-------|
| Cold build | ~8 min | ≤5 min |
| Cached build (lockfile unchanged) | N/A | ≤90 s |
| Cached build (lockfile changed) | N/A | ≤3 min |
| Image size | ~350 MB | ≤220 MB |
| Cache hit rate target | N/A | >80% |

## Monitoring and alerting

The workflow emits a dedicated summary job with each gate result. The `docker-build` job exports build duration and cache hit metrics via GitHub Actions output. Repository branch protection should require `CI summary`, `Security review gates`, and the service jobs relevant to protected branches. GitHub notification routing should alert maintainers when the summary job fails on `main` or `develop`.

A dedicated Grafana dashboard (`monitoring/dashboards/docker-build-performance.json`) and Prometheus alerting rules (`monitoring/alerts/docker-build-alerts.yaml`) track:

- Build duration (avg, P99)
- Cache hit ratio
- Build frequency by branch
- Recent build failures

## Runbook

1. Inspect the `CI summary` job to identify the failing gate.
2. Open the failing parallel job and review the first failing command.
3. For dependency vulnerabilities, upgrade the affected package or document a temporary exception in the security review.
4. For P99 smoke failures, compare the load-test output to the 100ms threshold and profile the changed critical path.
5. For infrastructure failures, render the Helm chart locally with `helm template lumina helm` and validate blue-green manifests before re-running CI.
6. For Docker build failures, see `runbooks/docker-build.md` for cache invalidation diagnosis and manual cache warmup steps.
