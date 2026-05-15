# Lane 08: Adversarial Test Gate And Operations

Severity: high

## Problem

The current test suite proves happy paths and some important negative cases,
but it does not yet function as an adversarial gate. Several serious issues
were only found by manual/subagent review:

- promotion without server-owned manifest;
- partial commit visibility;
- zstd/canonical hash re-verification gaps;
- remote read surface gaps;
- schema drift not detected;
- large bundle failure mode;
- public endpoint abuse.

These need to become repeatable tests and operational checks.

## Required Changes

### 1. Add An Adversarial Test Suite

Create a named test group:

```text
apps/api/test/adversarial/
apps/cli/test/cli/adversarial/
```

Or use file names with `adversarial` if the existing test layout is preferred.

The suite should be runnable with:

```text
just test-adversarial
```

### 2. Add Just Targets

Add:

```text
just test-adversarial
just quality-adversarial
```

`quality-adversarial` should run:

```text
pnpm build
just typecheck
just lint-all
just test-all
just test-adversarial
just e2e-up
just e2e
just e2e-cli
just e2e-down
pnpm audit --audit-level moderate
```

If audit still fails due known dev dependencies, the command can call an audit
classification script instead of raw audit, but the failure must be explicit.

### 3. Add Database Safety Guard For Docker E2E

Current E2E tests reset Postgres with:

```sql
DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;
```

This is fine only if the connection URL is guaranteed to point to a disposable
test database.

Add a guard that refuses destructive reset unless:

- host is localhost/127.0.0.1;
- database name matches `prosa_test` or an allowlisted pattern;
- env var such as `PROSA_ALLOW_DESTRUCTIVE_E2E_RESET=1` is set by `just e2e`.

### 4. Add Audit Classification

Create a checked-in report:

```text
docs/security/audit-exceptions.md
```

or generated artifact:

```text
docs/roadmap/server-sync/adversarial-hardening/audit-results.md
```

For each advisory:

- package;
- path;
- severity;
- runtime/dev;
- exploitability in prosa;
- mitigation;
- target upgrade.

### 5. Add CI Gate Documentation

Document which commands should run in CI before merge:

- standard unit/integration tests;
- adversarial tests;
- Docker E2E;
- audit classification;
- schema verification.

## Adversarial Test Matrix

### Promotion

- commit failure after session insert leaves no readable row;
- verify wrong store path fails;
- verify empty declarations for non-empty batch fails;
- plan/commit manifest mismatch fails;
- ack cleanup before verified fails;
- receipt counts are batch-scoped.

### CAS/Object Store

- upload object not in manifest fails;
- upload without batch/upload token fails;
- zstd canonical hash mismatch fails;
- transport hash mismatch fails;
- object store metadata corruption fails verification;
- oversized body fails;
- decompression bomb fails;
- GET streams large object without buffering.

### Tenant/Auth

- spoofed tenant header fails;
- cross-tenant object attachment fails;
- non-admin invite fails;
- duplicate membership impossible;
- revoked device cannot sync;
- public endpoints rate limited.

### Remote Reads

- promoted store with missing local bundle:
  - supported commands use remote;
  - unsupported commands fail closed;
  - no command silently reads local.

### Large Bundles

- >10k rows sync via chunks;
- retry chunk idempotent;
- missing chunk prevents verify;
- object upload not repeated unnecessarily.

### Schema

- missing column fails startup;
- missing FK/index fails startup;
- old schema migrates or fails safely.

## Acceptance Criteria

- `just quality-adversarial` exists.
- Destructive E2E reset is guarded.
- Every critical/high lane has at least one adversarial regression test.
- Audit output is classified.
- CI documentation exists.
- A future agent can run one command to reproduce the security gate.

## Files Likely Touched

- `.justfile`
- `apps/api/test/adversarial/*`
- `apps/cli/test/cli/adversarial/*`
- `docs/security/*`
- `docs/roadmap/server-sync/adversarial-hardening/*`
- CI config if present.

## Non-Goals

- This lane should not implement the fixes themselves. It should add the
  adversarial test harness and operational gates after or alongside the fix
  lanes.

