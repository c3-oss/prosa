# Web Platform Ralph Loop Restart: CQ-011 and CQ-012 Only

Restart from the current repository state.

Read these files before changing anything:

- `docs/roadmap/web-platform/ralph-loop-prompt.md`
- `docs/roadmap/web-platform/correction-queue.md`
- `docs/roadmap/web-platform/gates.md`
- `docs/roadmap/web-platform/status.md`
- `docs/roadmap/web-platform/evidence/lane-08.md`

## Scope

Fix only the open blocking corrections:

- CQ-011: browser-origin device-token flow must not return bearer tokens.
- CQ-012: final gate matrix and stabilization evidence must be complete.

Do not edit, reopen, or reinterpret CQ-001 through CQ-010 unless a new failing
test proves a regression. If you find a possible issue outside CQ-011/CQ-012,
document it in your final notes and stop; do not expand scope on your own.

## CQ-011 Requirements

The invariant is strict: any request with a non-empty `Origin` header is a
browser-origin caller and must not receive bearer tokens in JSON.

Fix both token issuance paths:

- tRPC `auth.deviceToken` in `apps/api/src/trpc/routers/auth.ts`
- raw Better Auth `/api/auth/device/token` path through `apps/api/src/app.ts`

Accepted behavior:

- no-`Origin` CLI/device flow still receives the token after approval;
- browser-origin callers are rejected or receive a fail-closed response with no
  token-bearing fields;
- browser-origin responses must not include `token`, `access_token`,
  `refresh_token`, nested token fields, or any bearer token value.

Add regression coverage for:

- `auth.deviceToken` with `Origin = PROSA_API_URL` or the configured web origin;
- raw `/api/auth/device/token` with browser `Origin`;
- the existing no-`Origin` CLI/device flow.

Run at minimum:

```text
pnpm --filter @c3-oss/prosa-api typecheck
pnpm --filter @c3-oss/prosa-api exec vitest run test/device-auth.test.ts test/verifier-fixes.test.ts
```

If the focused test filenames differ after your changes, run the equivalent
focused API auth/verifier tests and record the exact commands in evidence.

## CQ-012 Requirements

Final acceptance is blocked until the gate matrix and final stabilization
evidence are consistent.

Resolve the Docker E2E classification one way:

- run `just e2e-up`, `just e2e`, `just e2e-cli`, and `just e2e-down`; or
- update `ralph-loop-prompt.md`, `gates.md`, `status.md`, and lane evidence so
  they consistently state Docker E2E is not a required web-platform gate, with
  the reason Codex accepted that scope.

Re-run or explicitly reclassify every base gate listed in the prompt:

```text
pnpm i
pnpm build
just typecheck
just test-all
just lint-all
pnpm audit --audit-level moderate
git diff --check
```

Focused gates that must also be current after CQ-011:

```text
pnpm --filter @c3-oss/prosa-api typecheck
pnpm --filter @c3-oss/prosa-api exec vitest run test/device-auth.test.ts test/verifier-fixes.test.ts test/reads-v0.test.ts test/verified-provenance.test.ts test/correction-fixes.test.ts
pnpm --filter @c3-oss/prosa exec vitest run test/cli/remote-authority.test.ts test/cli/remote-authority-routing.test.ts
pnpm --filter @c3-oss/prosa-web exec playwright test e2e/authenticated.spec.ts e2e/marketing.spec.ts --reporter=list
```

If any command cannot run, document the blocker, exact failure, and accepted
fallback in `gates.md`, `status.md`, and the relevant evidence file. Do not
mark a gate as both required and out-of-scope without an explicit accepted
scope note.

## Evidence Updates

Before final stabilization, update:

- `docs/roadmap/web-platform/correction-queue.md`
- `docs/roadmap/web-platform/gates.md`
- `docs/roadmap/web-platform/status.md`
- relevant lane evidence files

The documents must agree on:

- current HEAD;
- open and closed correction status;
- which gates ran;
- which gates are explicitly classified;
- why any required-looking gate is not required for this lane;
- CQ-011 device-token behavior and tests.

## Final Stabilization

Do not output `RALPH_DONE` immediately after a fix, evidence update, or commit.

After all open corrections are closed and all gate/evidence documents are
consistent, perform exactly five consecutive clean stabilization cycles:

1. Sleep exactly 180 seconds.
2. Reread:
   - `docs/roadmap/web-platform/correction-queue.md`
   - `docs/roadmap/web-platform/gates.md`
   - `docs/roadmap/web-platform/status.md`
   - `git status --short --branch`
   - recent commits
3. If any open blocker, dirty/unexplained worktree state, new commit, failed
   command, stale evidence, or contradiction appears, fix it and reset the
   clean-cycle count to zero.
4. If everything remains clean and consistent, increment the clean-cycle count.

Record all five cycles in `status.md` with timestamps. The five cycles must
span at least 15 minutes after the final commit.

Output `RALPH_DONE` only after five consecutive clean cycles are recorded, and
only as the final completion signal.

## Completion Promise

```text
RALPH_DONE
```
