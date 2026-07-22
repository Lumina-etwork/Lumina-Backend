# Docker Build Troubleshooting Runbook

## Expected Build Times

| Condition | Backend | Health-Monitor |
|-----------|---------|----------------|
| Cold build (no cache) | ~5 min | ~3 min |
| Cache hit, lockfile unchanged | ~90 s | ~60 s |
| Cache hit, lockfile changed | ~3 min | ~2 min |
| Only source changed | ~30 s | ~20 s |

## Investigating Slow Builds

### 1. Check cache hit status in CI logs

Look for lines like this in the `docker-build` job output:

```
#9 importing cache manifest from ghcr.io/...
#9 DONE 1.2s

#10 [builder 2/5] RUN --mount=type=cache,target=/root/.npm npm ci ...
#10 CACHED
```

If layers show `CACHED`, cache is working. If every layer shows `[builder */*]` without `CACHED`, the cache was missed entirely.

### 2. Common cache invalidation scenarios

| Change | Layers Invalidated | Impact |
|--------|-------------------|--------|
| `package-lock.json` modified | Deps + everything after | Full rebuild |
| `Dockerfile` modified | All layers after the changed line | Partial rebuild |
| Base image digest changed | Entire image | Full rebuild |
| `.dockerignore` changed | `COPY . .` layer | Source layer only |
| BuildKit version updated | Cache scope mismatch | Full miss |

### 3. Clearing the cache

If cache is corrupted or you need a fresh build:

```bash
# Clear local BuildKit cache
docker buildx prune --all

# In CI: force a fresh build by changing the cache scope
# Edit ci.yml scope from docker-backend to docker-backend-v2
# Or modify cache key strategy to include a version prefix
```

## Diagnosing CI Failures

### Docker build fails with "no space left on device"

```bash
# Check disk usage on CI runner
df -h

# Clean up Docker resources
docker system prune --all --volumes -f
```

### Docker build fails with "timeout"

The `docker-build` job has a 15-minute timeout. For large dependency updates:

1. Check if a dependency download is stuck
2. Verify network connectivity to npm registry
3. Consider splitting into separate build jobs

### Cache not being restored across builds

1. Verify the `cache-from` and `cache-to` scopes match exactly
2. Check that `GITHUB_TOKEN` has `packages: write` permission
3. Confirm that the branch is not filtered out by cache restore rules

## Manual Cache Warmup

To seed the cache for a new branch or after a major dependency update:

1. Push a commit to `main` that triggers the `docker-build` job
2. The cache is saved automatically via `cache-to: type=gha`
3. Subsequent PR branches will restore from the `main` cache

## BuildKit Reference

Enable BuildKit locally:

```bash
export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1
docker buildx ls  # Verify builder is available
```

For a cache-enabled local build (simulating CI):

```bash
docker buildx build \
  --cache-from type=gha,scope=docker-backend \
  --cache-to type=gha,mode=max,scope=docker-backend \
  -t vesting-vault-backend:latest \
  backend/
```
