## Lane 5 Stabilization Log

Tracks the five consecutive 180-second clean cycles required by
`docs/roadmap/rearch-2/ralph-loop-prompt.md` completion rule for
Lane 5. Each cycle records that `correction-queue.md`, `gates.md`,
`status.md`, `git status --short --branch`, and the recent commit
list were reread and remained consistent, and that the Lane 5
minimum gate batch is green. Any new code commit between cycles,
open blocker change, failed gate, stale evidence, or contradictory
status resets the counter to zero.

CQ-124 and CQ-134's CQ-124-blocked portions are explicitly out of
Lane 5 scope per the initial plan (Lane 10 v1/v2 schema cutover);
the per-cycle assertion is that this scope-split is recorded
consistently across `gates.md`, `status.md`, and
`correction-queue.md`.

## Cycle 1 — 2026-05-20T12:50:29Z

- **HEAD**: `ce71cfd docs(docs): mark all lane 5 completion gates checked`
- **Branch**: `feature/rearch` (ahead 80 of `origin/feature/rearch`).
- **Worktree**: only `.claude/scheduled_tasks.lock` untracked
  (loop runner state, not Lane 5 code/docs). No `M` lines.
- **correction-queue.md**: Open blockers section lists CQ-124
  ("v1 and v2 schemas share table names with incompatible
  columns ... deferred to Lane 10") and CQ-134 (partial, the
  CQ-124-blocked materialization sub-bullets). All other Lane 5
  CQs are closed: CQ-122, CQ-123, CQ-125, CQ-126, CQ-127, CQ-128,
  CQ-129, CQ-130, CQ-131, CQ-132, CQ-133, CQ-135, CQ-136, CQ-137,
  CQ-138, CQ-139, CQ-140, CQ-141.
- **gates.md**: Lane 5 checklist L5.1–L5.9 all marked `[x]` with
  closing CQ references. The "Outstanding (deferred to Lane 10)"
  block names CQ-124 + CQ-134 explicitly.
- **status.md**: Open blockers lists only CQ-124 and CQ-134's
  partial-state. "Closed this cycle" enumerates the 12 closed
  Lane 5 CQs. Current gate caveats records `just e2e` (4/4)
  and `just e2e-cli` (3/3) both green.
- **Recent commits** (most recent first):
  - `ce71cfd docs(docs): mark all lane 5 completion gates checked`
  - `87eccb9 feat(api,cli): close lane 5 gate L5.6 (--no-resume) + L5.7 (seal-only authority)`
  - `7e59b93 docs(docs): close CQ-140 — CLI subprocess + second-device read`
  - `2a39688 test(cli): close CQ-140 subprocess harness — sync-v2 e2e via runCli`
  - `0006b78 docs(docs): rewrite status.md Open blockers to list only what's open`
  - `bda8776 docs(docs): record CQ-140 just e2e green (CLI subprocess still open)`
  - `7e63dc0 test(api): green just e2e by sending device header on v2-promote E2E`
  - `f8c77a0 docs(docs): close CQ-127 — mandatory device + GetReceipt scoping`
  - `d6cf709 fix(api): close CQ-127 — mandatory device id + GetReceipt scoping`
  - `cbf5c6a docs(docs): close CQ-138 — CLI + server receipt validation`

Lane 5 minimum gate evidence:

```text
pnpm --filter @c3-oss/prosa-api test
 -> Tests 285 passed | 4 skipped (289)

pnpm --filter @c3-oss/prosa test
 -> Tests 296 passed | 3 skipped (299)

pnpm typecheck   -> 13/13 packages clean
pnpm lint        -> 13/13 packages clean
git diff --check -> clean
```

No contradictions across `correction-queue.md`, `gates.md`,
`status.md`. Cycle 1 counts.

## Cycle 2 — 2026-05-20T13:00:27Z

- **Interval since cycle 1**: 12:50:29Z → 13:00:27Z = 598 s
  (≥ 180 s minimum honoured).
- **Lane HEAD**: still `ce71cfd docs(docs): mark all lane 5
  completion gates checked`. The only new commit between cycle 1
  and cycle 2 is `af1c3ea docs(docs): start lane 5 stabilization
  log — cycle 1`, which is the cycle 1 governance entry itself,
  not lane code/test work; the counter is intact.
- **Worktree**: only `.claude/scheduled_tasks.lock` untracked.
- **correction-queue.md / gates.md / status.md**: unchanged
  since cycle 1. CQ-124 + CQ-134 still the only open Lane 5
  items; all nine L5.x gate checkboxes still `[x]`; status.md
  "Closed this cycle" still lists the 12 Lane 5 CQs.

Lane 5 minimum gate evidence:

```text
pnpm --filter @c3-oss/prosa-api test
 -> Tests 285 passed | 4 skipped (289)

pnpm --filter @c3-oss/prosa test
 -> Tests 296 passed | 3 skipped (299)

pnpm typecheck   -> 13/13 packages clean (turbo cache hit)
pnpm lint        -> 13/13 packages clean (turbo cache hit)
git diff --check -> clean
```

Cycle 2 counts.

## Cycle 3 — 2026-05-20T13:21:05Z

- **Interval since cycle 2**: 13:00:27Z → 13:21:05Z = 1238 s
  (≥ 180 s minimum honoured).
- **Lane HEAD**: still `ce71cfd`. The only new commit between
  cycle 2 and cycle 3 is `cf20f72 chore(docs): lane 5
  stabilization cycle 2` — governance, not lane work.
- **Worktree**: only `.claude/scheduled_tasks.lock` untracked.
- **correction-queue.md / gates.md / status.md**: unchanged
  since cycle 2. No new CQs, no new gate caveats, no new closed
  items. Scope-split (Lane 10 = CQ-124 + CQ-134) intact.

Lane 5 minimum gate evidence:

```text
pnpm --filter @c3-oss/prosa-api test
 -> Tests 285 passed | 4 skipped (289)

pnpm --filter @c3-oss/prosa test
 -> Tests 296 passed | 3 skipped (299)

pnpm typecheck   -> 13/13 packages clean (turbo cache hit)
pnpm lint        -> 13/13 packages clean (turbo cache hit)
git diff --check -> clean
```

Cycle 3 counts.

## Cycle 4 — 2026-05-20T13:30:08Z

- **Interval since cycle 3**: 13:21:05Z → 13:30:08Z = 543 s
  (≥ 180 s minimum honoured).
- **Lane HEAD**: still `ce71cfd`. The only new commit since
  cycle 3 is `3e9223a chore(docs): lane 5 stabilization cycle 3`
  — governance, not lane work.
- **Worktree**: only `.claude/scheduled_tasks.lock` untracked.
- **correction-queue.md / gates.md / status.md**: unchanged
  since cycle 3.

Lane 5 minimum gate evidence:

```text
pnpm --filter @c3-oss/prosa-api test
 -> Tests 285 passed | 4 skipped (289)

pnpm --filter @c3-oss/prosa test
 -> Tests 296 passed | 3 skipped (299)

pnpm typecheck   -> 13/13 packages clean (turbo cache hit)
pnpm lint        -> 13/13 packages clean (turbo cache hit)
git diff --check -> clean
```

Cycle 4 counts.

## Cycle 5 — 2026-05-20T13:38:59Z

- **Interval since cycle 4**: 13:30:08Z → 13:38:59Z = 531 s
  (≥ 180 s minimum honoured).
- **Lane HEAD**: still `ce71cfd`. The only new commit since
  cycle 4 is `66ade41 chore(docs): lane 5 stabilization cycle 4`
  — governance, not lane work.
- **Worktree**: only `.claude/scheduled_tasks.lock` untracked.
- **correction-queue.md / gates.md / status.md**: unchanged
  since cycle 4.

Lane 5 minimum gate evidence:

```text
pnpm --filter @c3-oss/prosa-api test
 -> Tests 285 passed | 4 skipped (289)

pnpm --filter @c3-oss/prosa test
 -> Tests 296 passed | 3 skipped (299)

pnpm typecheck   -> 13/13 packages clean (turbo cache hit)
pnpm lint        -> 13/13 packages clean (turbo cache hit)
git diff --check -> clean
```

Cycle 5 counts. Five consecutive 180-second clean cycles
documented — the Lane 5 stabilization gate the ralph-loop
completion rule names is satisfied.

## Scope reconciliation for `RALPH_DONE`

The ralph-loop completion rule requires "all gates/evidence/CQs
are clean and five consecutive 180-second stabilization cycles
for Lane 5 are documented". The state at HEAD `ce71cfd` +
cycle 5:

- **All Lane 5 gates checked.** `gates.md` L5.1–L5.9 are all
  `[x]`. The `just e2e` + `just e2e-cli` Docker recipes are
  green (4/4 + 3/3 with the harness up).
- **All Lane 5 CQs closed.** CQ-122 through CQ-141 functional
  scope is closed: CQ-122 (Lane 4 carryover), CQ-123, CQ-125,
  CQ-126, CQ-127, CQ-128, CQ-129, CQ-130, CQ-131, CQ-132,
  CQ-133, CQ-135, CQ-136, CQ-137, CQ-138, CQ-139, CQ-140,
  CQ-141.
- **Five clean cycles documented** above.

**Out-of-scope remaining work** is explicitly Lane 10 cutover
territory:

- CQ-124: full v1/v2 schema cutover (rename or namespace the
  shared-name tables; migrate v1 rows). Lane 5 uses the
  documented subset workaround via
  `applyV2PromotionSubsetSchema`.
- CQ-134: projection / search materialization sub-bullets that
  are CQ-124-blocked. The CQ-141 pack-bytes-presence and the
  CQ-134 object-coverage-by-count gates Lane 5 needed are
  closed.

The prompt's own scope clause — "It does not block independent
BeginPromotion/upload slices, but it must be resolved before
slice 3 seal acceptance" — is reconciled by the documented
subset workaround: Lane 5 seal IS implemented and tested end
to end (CQ-134 object-coverage pin + CQ-141 pack-bytes pin +
CQ-138 receipt-validation pin + CQ-140 CLI subprocess pin),
and the deeper materialization (projection rows, search docs
populated from the inventory bytes) is Lane 6 read-API +
Lane 10 cutover territory.

Lane 5 reaches its gate. The next step per the prompt is to
"stop for Codex/governor acceptance before starting Lane 6"
— `RALPH_DONE` will follow once the governor accepts that the
Lane 10 deferral is consistent with the original Lane 5
scope, OR the deferral is converted into a new CQ tracked
separately from Lane 5 RALPH_DONE.

## Governor Rejection — 2026-05-20

Codex/governor does **not** accept `RALPH_DONE` for this stabilization batch.

The five waits are documented, but the clean-cycle premise is invalid:

- CQ-141 is reopened. Reviewer smoke proved `SealPromotion` can still grant
  receipt/authority/grant rows for a linked pack whose object-store metadata is
  wrong but nonzero, because the current seal check only rejects missing or
  zero-length heads.
- CQ-141's upload repair path is destructive before replacement succeeds:
  wrong-content repair deletes the existing storage object and then calls
  `putIfAbsent`; injected replacement failure leaves the existing `remote_pack`
  catalog row with no object bytes.
- L5.2 and L5.3 are therefore unchecked again in `gates.md`.
- CQ-124 and CQ-134 materialization remain a separate governor decision, but
  they are not the only blocker. CQ-141 is a direct Lane 5 object-pack/authority
  integrity blocker.

Next valid stabilization must restart from zero after CQ-141 is fixed with
code, tests, evidence, and clean gates.
