# Runbook: Pre-Commit Hook Failures

## Symptoms

- `git commit` is rejected with a lint/format error
- `git push` fails at the pre-push stage
- Developer workflow is interrupted

## Common Failures

### 1. ESLint / Prettier Formatting Error

**Error:** `warning: prettier/prettier` or `error: Insert `;``

**Cause:** Staged files don't match project formatting standards.

**Fix:**
```bash
# Auto-fix staged files
npx lint-staged

# Commit again
git commit
```

**Root cause resolution:** Run `npx prettier --write <file>` to fix formatting, then stage and commit.

### 2. Commit Message Rejected

**Error:** `commitlint: type must be one of [...]`

**Cause:** Commit message doesn't follow conventional commit format.

**Fix:** Rewrite the commit message:
```bash
git commit --amend -m "feat: your message here"
```

Valid types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

### 3. Secret Detection Failure

**Error:** `secretlint: Found secret in <file>`

**Cause:** Staged file contains an API key, token, or credential.

**Fix:** Remove the secret from the file, use environment variables or a vault.

**Urgent:** If secret was committed (via bypass), rotate the credential immediately.

### 4. Rust Formatting Check Failed

**Error:** `cargo fmt` reports diff

**Cause:** Rust source files don't match `rustfmt.toml` rules.

**Fix:**
```bash
cargo fmt --manifest-path contracts/Cargo.toml --all
cargo fmt --manifest-path src/metering/Cargo.toml --all
# Stage the formatted files and re-commit
git add -u
git commit
```

### 5. CI Still Fails After Hooks Pass

**Cause:** Pre-commit hooks only check staged files; unstaged changes or CI-specific issues may cause failures.

**Fix:**
- Ensure all changes are staged: `git add -A`
- Check CI logs for differences (e.g., stricter CI rules)
- Run full lint/tests locally: `npm test && npx eslint . && npx prettier --check .`

## Emergency Bypass

When urgent and quality checks must be skipped:

```bash
# Bypass all hooks for this commit only
git commit --no-verify -m "urgent: fix production issue"

# Bypass pre-push only
git push --no-verify
```

**Post-bypass action:** Create a follow-up PR to fix any quality issues.

## Disable Hooks Completely

```bash
# Per-environment (CI auto-disables)
export HUSKY=0

# Permanent uninstall
npx husky uninstall

# Reinstall later
npx husky
```

## Escalation

If hooks are consistently failing and blocking development:

1. Check if a config change broke compatibility
2. Verify tool versions: `npx eslint --version`, `npx prettier --version`
3. Check for `.husky/_/` corruption: delete and re-run `npx husky`
4. File a ticket in #engineering-support
