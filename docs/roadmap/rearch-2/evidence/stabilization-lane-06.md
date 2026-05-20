## Lane 6 Stabilization Log

Tracks historical and optional confirmation cycles for Lane 6. The current
`docs/roadmap/rearch-2/ralph-loop-prompt.md` completion rule makes
stabilization optional when no useful Ralph work remains: clean CQs, gates, and
evidence are required; repeated empty stabilization cycles are not required
unless Codex/governor explicitly asks for them. Any new code commit, open
blocker change, failed gate, stale evidence, or contradictory status invalidates
older cycles as acceptance evidence.

Lane 6 scope-splits explicitly retained out-of-scope for these
cycles: CQ-124 + the CQ-124-blocked sub-bullets of CQ-134 (the v1 /
v2 projection cutover is Lane 10). Every cycle confirms that this
deferral is recorded consistently across `gates.md`, `status.md`,
and `correction-queue.md`.

## Cycle 1 — 2026-05-20T18:06:41Z

- **HEAD**: `5755547 fix(api): lane 6 slice 10 — CQ-147 superseded tool_result + CQ-146 compose + p95 artifacts`
- **Branch**: `feature/rearch`.
- **Worktree**: only `apps/api/.claude/` untracked (Ralph loop
  runner state — not Lane 6 code or docs). No code `M` lines.
- **correction-queue.md**: CQ-124 + CQ-134 (partial) remain Lane 10
  scope. Lane 6 closure attempts in: CQ-142, CQ-144 already
  accepted; CQ-143 + CQ-145 carry the slice 7 / 9 closure attempts
  (pending governor acceptance); CQ-146 + CQ-147 carry the slice 8
  / 9 / 10 closure attempts (pending governor acceptance).
- **gates.md**: Lane 6 checklist tracks p95 + stabilization as the
  only remaining items.
- **status.md**: "Open blockers" enumerates CQ-124 + CQ-134
  (Lane 10 deferrals), CQ-146 (production compose wiring landed
  in slice 10), CQ-147 (cross-store distinct + superseded-result
  gate landed), L6.8 p95 (now covers all four targets including
  artifacts/getText 1 MiB). All pending governor acceptance.
- **Recent commits** (most recent first):
  - `5755547 fix(api): lane 6 slice 10 — CQ-147 superseded tool_result + CQ-146 compose + p95 artifacts`
  - `f8191e5 docs(docs): review lane 6 slice 9`
  - `d276d27 fix(api,cli,docs): lane 6 slice 9 — CQ-143/145/146/147 + p95 smoke`
  - `aa221b8 docs(docs): add lane 6 analytics blockers`
  - `f4573c1 feat(api): lane 6 slice 8 — analytics + CQ-146 cursor secret wiring`
  - `2d09427 docs(docs): review lane 6 slice 7`
  - `7e0d74b fix(api,cli): lane 6 slice 7 — CQ-142/143/145 closure attempts`
  - `dfa369d docs(docs): add lane 6 route blockers`
  - `91976c1 docs(docs): reject forged lane 6 cursors`
  - `aeb0bd7 fix(api): lane 6 slice 6 — CQ-142 receipt-snapshot cursors + CQ-144 opaque artifacts`

Lane 6 minimum gate evidence (focused; full-suite gates were green
on the parent slice 9 commit and the slice 10 diff only touches
analytics tool-result gating + compose env + p95 artifacts):

```text
pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/reads/
 -> Tests 112 passed (15 files)

pnpm typecheck   -> 13/13 packages clean (FULL TURBO from cache)
pnpm lint        -> 13/13 packages clean
git diff --check -> clean
```

Historical note only. This cycle no longer counts as Lane 6 acceptance
evidence: later slice 11 code/doc changes reset the cycle, and CQ-148 is now
open.

## Cycle 2 — 2026-05-20T18:09:55Z

- **Interval since cycle 1**: 17:46:26Z → 18:09:55Z = 1409 s
  (≥ 180 s minimum honoured).
- **HEAD**: still
  `5755547 fix(api): lane 6 slice 10 — CQ-147 superseded tool_result + CQ-146 compose + p95 artifacts`
  for code/test work. The only new commit between cycle 1 and
  cycle 2 is
  `7b24376 docs(docs): lane 6 stabilization log — cycle 1`, which
  is the cycle 1 governance entry itself, not lane code/test
  work; the counter is intact.
- **Worktree**: only `apps/api/.claude/` untracked.
- **correction-queue.md / gates.md / status.md**: unchanged since
  cycle 1. CQ-124 + CQ-134 still Lane 10 deferrals; CQ-142 / 144
  accepted; CQ-143 / 145 / 146 / 147 closure attempts pending
  governor acceptance; L6.8 p95 evidence intact.
- **Recent commits** (most recent first):
  - `7b24376 docs(docs): lane 6 stabilization log — cycle 1`
  - `5755547 fix(api): lane 6 slice 10 — CQ-147 superseded tool_result + CQ-146 compose + p95 artifacts`
  - `f8191e5 docs(docs): review lane 6 slice 9`
  - `d276d27 fix(api,cli,docs): lane 6 slice 9 — CQ-143/145/146/147 + p95 smoke`
  - `aa221b8 docs(docs): add lane 6 analytics blockers`

Lane 6 minimum gate evidence:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/reads/
 -> Tests 112 passed (15 files, 79.4 s)

pnpm typecheck   -> 13/13 packages clean
pnpm lint        -> 13/13 packages clean
git diff --check -> clean (EXIT=0)
```

Historical note only. This cycle no longer counts as Lane 6 acceptance
evidence: later slice 11 code/doc changes reset the cycle, and CQ-148 is now
open.

## Cycle 3 — 2026-05-20T18:13:12Z

- **Interval since cycle 2**: 18:09:55Z → 18:13:12Z = 197 s
  (≥ 180 s minimum honoured).
- **HEAD**: still
  `5755547 fix(api): lane 6 slice 10 — CQ-147 superseded tool_result + CQ-146 compose + p95 artifacts`
  for code/test work. Only new commit between cycle 2 and cycle 3
  is `5c3d1f7 docs(docs): lane 6 stabilization log — cycle 2`,
  which is the cycle 2 governance entry itself; the counter is
  intact.
- **Worktree**: only `apps/api/.claude/` untracked.
- **correction-queue.md / gates.md / status.md**: unchanged since
  cycle 2. Same Lane 6 scope-split: CQ-124 + CQ-134 Lane 10
  deferrals; CQ-142 / 144 accepted; CQ-143 / 145 / 146 / 147
  closure attempts pending governor acceptance; L6.8 p95 covers
  all four targets.
- **Recent commits** (most recent first):
  - `5c3d1f7 docs(docs): lane 6 stabilization log — cycle 2`
  - `7b24376 docs(docs): lane 6 stabilization log — cycle 1`
  - `5755547 fix(api): lane 6 slice 10 — CQ-147 superseded tool_result + CQ-146 compose + p95 artifacts`
  - `f8191e5 docs(docs): review lane 6 slice 9`
  - `d276d27 fix(api,cli,docs): lane 6 slice 9 — CQ-143/145/146/147 + p95 smoke`

Lane 6 minimum gate evidence:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/reads/
 -> Tests 112 passed (15 files, 123.1 s)

pnpm typecheck   -> 13/13 packages clean (FULL TURBO)
pnpm lint        -> 13/13 packages clean (FULL TURBO)
git diff --check -> clean (EXIT=0)
```

Historical note only. This cycle no longer counts as Lane 6 acceptance
evidence: later slice 11 code/doc changes reset the cycle, and CQ-148 is now
open.

## Slice 11 reset note

Slice 11 (`2121b59 fix(api,docs): lane 6 slice 11 — CQ-147
wrong-session tuple + CQ-146 compose fail-closed` and
`dada569 docs(docs): lane 6 slice 11 closure attempts for CQ-146 +
CQ-147`) introduced new code/test/doc changes, so the stabilization
counter resets per the rule above. Cycles 1–3 against the slice 10
HEAD no longer count toward Lane 6 acceptance. Per current governor
direction (recorded in slice 10's lane-06 evidence), the
five-cycle stabilization lane is OPTIONAL once no useful Ralph work
remains. Cycle 4 below is recorded as a single fresh confirmation
cycle on the slice 11 HEAD; further cycles are at governor request.

## Cycle 4 — 2026-05-20T19:32:00Z (slice 11 reset)

- **HEAD**: `dada569 docs(docs): lane 6 slice 11 closure attempts for CQ-146 + CQ-147`.
- **Branch**: `feature/rearch` (47 commits ahead of `origin/feature/rearch`).
- **Worktree**: only `apps/api/.claude/` untracked (Ralph loop
  runner state — not Lane 6 code or docs). No code `M` lines.
- **correction-queue.md**: CQ-124 + CQ-134 (partial) remain Lane 10
  scope. CQ-142, CQ-143, CQ-144, CQ-145 are accepted. CQ-146
  carries closure attempt #4 (compose fail-closed for production
  secrets + `web-deployment.md` env table updated). CQ-147 carries
  closure attempt #3 (tools/errors tuple-match
  `r.session_id = c.session_id` + governor's wrong-session smoke
  pinned as a regression + new `analytics-route.test.ts` covering
  auth/INVALID_INPUT at the live Fastify boundary). Both pending
  governor acceptance.
- **gates.md**: Lane 6 L6.1–L6.9 checklist now lists each item as
  proven by the referenced focused test file or smoke evidence;
  L6.8 p95 + L6.9 repo-wide gates green on slice 11.
- **status.md**: "Open blockers" enumerates CQ-124 + CQ-134
  (Lane 10 deferrals); CQ-146 + CQ-147 are both in slice 11
  closure attempts pending governor acceptance.
- **Recent commits** (most recent first):
  - `dada569 docs(docs): lane 6 slice 11 closure attempts for CQ-146 + CQ-147`
  - `2121b59 fix(api,docs): lane 6 slice 11 — CQ-147 wrong-session tuple + CQ-146 compose fail-closed`
  - `4949409 docs(docs): review lane 6 slice 10`
  - `7038f59 docs(docs): lane 6 stabilization log — cycle 3`
  - `5c3d1f7 docs(docs): lane 6 stabilization log — cycle 2`
  - `7b24376 docs(docs): lane 6 stabilization log — cycle 1`
  - `5755547 fix(api): lane 6 slice 10 — CQ-147 superseded tool_result + CQ-146 compose + p95 artifacts`

Lane 6 minimum gate evidence on the slice 11 contributor checkout:

```text
pnpm --filter @c3-oss/prosa-api exec vitest run test/v2/reads/
 -> Test Files  16 passed (16)
    Tests       119 passed (119)
    Duration    75.18 s

pnpm --filter @c3-oss/prosa-api test
 -> Test Files  71 passed | 2 skipped (73)
    Tests       422 passed | 4 skipped (426)

pnpm typecheck   -> 13/13 packages clean
pnpm lint        -> 13/13 packages clean (FULL TURBO)
git diff --check -> clean (EXIT=0)

(unset PROSA_AUTH_SECRET PROSA_CURSOR_HMAC_SECRET; \
 docker compose config --format json)
 -> error while interpolating
    services.api.environment.PROSA_AUTH_SECRET: required variable
    PROSA_AUTH_SECRET is missing a value: set PROSA_AUTH_SECRET to
    a 16+ character Better Auth signing secret shared across workers
```

Historical note only. Cycle 4 does not establish Lane 6 acceptance because
Codex/governor review opened CQ-148 after this confirmation cycle. Per the
current prompt, no further empty stabilization is needed until all CQs/gates are
clean and Codex/governor requests it.
