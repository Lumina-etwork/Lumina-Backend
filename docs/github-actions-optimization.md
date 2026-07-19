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

## Monitoring and alerting

The workflow emits a dedicated summary job with each gate result. Repository branch protection should require `CI summary`, `Security review gates`, and the service jobs relevant to protected branches. GitHub notification routing should alert maintainers when the summary job fails on `main` or `develop`.

## Runbook

1. Inspect the `CI summary` job to identify the failing gate.
2. Open the failing parallel job and review the first failing command.
3. For dependency vulnerabilities, upgrade the affected package or document a temporary exception in the security review.
4. For P99 smoke failures, compare the load-test output to the 100ms threshold and profile the changed critical path.
5. For infrastructure failures, render the Helm chart locally with `helm template lumina helm` and validate blue-green manifests before re-running CI.
