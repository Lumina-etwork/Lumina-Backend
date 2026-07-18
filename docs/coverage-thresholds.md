# Code Coverage Threshold Enforcement

## Overview

The backend CI pipeline enforces Jest coverage thresholds for pull requests and pushes to `main` and `develop`. The coverage gate runs the existing backend test suite with coverage enabled and fails the workflow when coverage drops below the configured global thresholds.

## Architecture

1. GitHub Actions runs the `Coverage Gate` workflow on pull requests and protected branch pushes.
2. The workflow installs backend dependencies with `npm ci` from `backend/package-lock.json`.
3. The workflow executes `npm run test:coverage -- --ci --passWithNoTests` from the `backend` directory to generate coverage output consistently.
4. Jest evaluates the global `coverageThreshold` settings in `backend/jest.config.js`, and the explicit `npm run coverage:check` step verifies the generated summary for clear pass/fail output.
5. GitHub Actions uploads the generated `backend/coverage` directory as an artifact for review.

This keeps threshold values centralized in Jest while giving CI and local development a reusable summary checker.

## Thresholds

The current global thresholds are:

| Metric | Minimum |
| --- | ---: |
| Statements | 80% |
| Lines | 80% |
| Functions | 75% |
| Branches | 70% |

These values are intended to establish a baseline quality gate without blocking incremental improvements. Raise thresholds only after the repository consistently exceeds them on `main`.

## Developer workflow

Before opening a pull request, run:

```bash
cd backend
npm run test:coverage -- --ci --passWithNoTests
npm run coverage:check
```

If the command fails because coverage is below threshold, add tests for the changed behavior or adjust exclusions only when generated, bootstrap, or integration-boundary code cannot be tested meaningfully.

## Monitoring and alerting

Coverage gate failures surface directly in GitHub branch protection checks. Treat a failed `Coverage Gate / Backend Jest coverage threshold` check as a release-blocking quality signal. The uploaded coverage artifact can be downloaded from the workflow run to identify uncovered files and lines.

## Runbook

1. Open the failed GitHub Actions run.
2. Inspect the `Run coverage threshold gate` and `Enforce coverage thresholds` steps for the failed metric.
3. Download the `backend-coverage-report` artifact.
4. Open `lcov-report/index.html` locally to identify coverage gaps.
5. Add or update tests, then rerun the coverage command locally.
6. Push the fix and confirm the workflow passes before merging.

## Deployment considerations

This change affects CI only and does not alter runtime code paths, request handling, infrastructure manifests, or production deployment behavior. No blue-green or canary rollout is required for runtime safety; the workflow itself acts as a pre-merge gate.
