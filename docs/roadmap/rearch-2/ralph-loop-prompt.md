# Ralph Loop: rearch-2

You are implementing Prosa v2 from the lean execution plan in `docs/rearch-2/`
on branch `feature/rearch`.

Codex is acting as architect and gatekeeper. It may update correction and gate
files while you work. Treat those files as blocking input.

Codex will actively review your code with focused subagents and steer this run
through `correction-queue.md`, `gates.md`, and updates to this prompt. Those
review findings are part of the implementation contract, not optional advice.
Expect Codex to reject `RALPH_DONE` if subagent findings remain open.

This is a very large feature. Work strictly lane by lane. If one Ralph Loop
iteration cannot complete the entire roadmap, leave accurate status and evidence
for the completed partial lane work. Do not output `RALPH_DONE` unless every
lane below is complete and all required gates and stabilization steps have run.

## Read First

- `AGENTS.md`
- `docs/rearch-2/00-README.md`
- `docs/rearch-2/01-lane-0-foundation.md`
- `docs/rearch-2/02-lane-1-local-store.md`
- `docs/rearch-2/03-lane-2-importers.md`
- `docs/rearch-2/04-lane-3-derived-layer.md`
- `docs/rearch-2/05-lane-4-server.md`
- `docs/rearch-2/06-lane-5-sync-protocol.md`
- `docs/rearch-2/07-lane-6-read-api.md`
- `docs/rearch-2/08-lane-7-cli-and-mcp.md`
- `docs/rearch-2/09-lane-8-audit-and-gc.md`
- `docs/rearch-2/10-lane-9-migration.md`
- `docs/rearch-2/11-lane-10-cutover.md`
- `.codex/skills/prosa-dev-workflow/SKILL.md`
- `.codex/skills/prosa-store-schema-cas/SKILL.md`
- `.codex/skills/prosa-importers/SKILL.md`
- `.codex/skills/prosa-search-export/SKILL.md`
- `.codex/skills/prosa-server-sync/SKILL.md`
- `docs/architecture/bundle-format.md`
- `docs/architecture/import-pipeline.md`
- `docs/architecture/search-engines.md`
- `docs/architecture/server-sync.md`

## Product Contract

- Preserve raw bytes as the source of truth. Projection, search, exports, and
  analytics remain rebuildable derived layers.
- Re-import and re-promotion are idempotent. Re-running the same import or sync
  must not grow rows, objects, packs, or receipts unexpectedly.
- Canonical cross-provider graph unification is mandatory. Parent/subagent
  relationships require explicit evidence and must expose uncertainty when
  inference is weak.
- Content identity is BLAKE3 over uncompressed original bytes. Transport hashes,
  pack hashes, and stored-byte hashes are separate concepts.
- Signed promotion receipts are the remote authority. Remote reads must be
  receipt-pinned and fail closed when authority, tenant membership, or grants do
  not verify.
- Tenant isolation, device ownership, and object-route authorization must share
  the same auth semantics. Never trust `x-prosa-tenant-id` without membership.
- Bundle v2 work must stay alongside v1 until Lane 10. Do not remove or mutate
  v1 behavior before the cutover lane explicitly allows it.
- Generated directories (`dist/`, `coverage/`, `.turbo/`, `node_modules/`,
  `.devbox/`) must not be hand edited.

## Work Lanes

0. Foundation: create `packages/prosa-types-v2` and `packages/prosa-wire-v2`,
   canonical encoding, Merkle helpers, Zod wire schemas, and conformance
   fixtures.
1. Local store: create bundle v2, four RocksDB shards, CAS/raw/projection pack
   writers, epoch sealing, atomic head swap, and cold rebuild.
2. Importers: implement `LogicalImportUnit`, Reserve-before-parse,
   `GraphResolver`, and v2 importers for Codex, Claude Code, Cursor, Gemini,
   and Hermes.
3. Derived layer: implement local Tantivy, session blob packs, DuckDB/Parquet
   analytics views, and compaction.
4. Server: implement Postgres-only v2 schema, `/v2/*` server skeleton, Better
   Auth preservation, AWS KMS receipt signing, streaming validation, and cron
   skeleton.
5. Sync protocol: implement BeginPromotion, UploadSegment/UploadObjectPack,
   SealPromotion, GetReceipt, CLI `sync-v2`, resume, and Docker E2E.
6. Read API: implement receipt-pinned remote read endpoints, authority refresh,
   Postgres FTS, transcript reconstruction, artifact text reads, and analytics.
7. CLI and MCP: implement `prosa read *`, authority cache, MCP authority modes,
   TUI routing, and web data layer rewrite.
8. Audit and GC: implement audit/GC cron roles, advisory locks, receipt degrade,
   repair responses, and quarantined-pack read fallback.
9. Migration: implement `prosa migrate-v2` local and tenant migration,
   validation, atomic rename, remote re-projection, and legacy receipt archive.
10. Cutover: wire `PROSA_V2_ENABLED`, deprecation notices, rollout and rollback
    runbooks, web cutover, monitoring, and v1 decommission plan.

At the start of each iteration:

- inspect `git status --short --branch`;
- identify the first incomplete lane or open correction;
- reread `correction-queue.md` and treat every `Blocking: yes` correction as
  higher priority than new feature work;
- continue from the first incomplete lane without restarting completed work;
- preserve user changes and unrelated agent changes;
- do not touch generated directories by hand.

## Required Files

Keep these files current:

- `docs/roadmap/rearch-2/status.md`
- `docs/roadmap/rearch-2/correction-queue.md`
- `docs/roadmap/rearch-2/gates.md`
- `docs/roadmap/rearch-2/evidence/lane-00.md`
- `docs/roadmap/rearch-2/evidence/lane-01.md`
- `docs/roadmap/rearch-2/evidence/lane-02.md`
- `docs/roadmap/rearch-2/evidence/lane-03.md`
- `docs/roadmap/rearch-2/evidence/lane-04.md`
- `docs/roadmap/rearch-2/evidence/lane-05.md`
- `docs/roadmap/rearch-2/evidence/lane-06.md`
- `docs/roadmap/rearch-2/evidence/lane-07.md`
- `docs/roadmap/rearch-2/evidence/lane-08.md`
- `docs/roadmap/rearch-2/evidence/lane-09.md`
- `docs/roadmap/rearch-2/evidence/lane-10.md`

## Current Blocking Corrections

Before continuing beyond Lane 0, close every open `CQ-*` item in
`docs/roadmap/rearch-2/correction-queue.md` with code, tests, and evidence.
The initial Lane 0 review opened corrections for bundle/root semantics,
canonical normalization, raw-source roots, pack/transport hash separation,
receipt payload canonical bytes, source/raw idempotency keys, package
compile-clean status, and independent conformance fixtures.

## Implementation Rules

- Follow local repo conventions from `.codex/skills/prosa-dev-workflow/SKILL.md`.
- Commit coherent slices. Prefer lane-internal PR-sized commits: types before
  consumers, storage before importers, API schema before routes, routes before
  CLI consumers.
- Add or update tests with each meaningful behavior change.
- Do not mark evidence complete without command output, commit IDs, and a clear
  acceptance mapping.
- Close reviewer findings with code, tests, and evidence; do not mark a
  correction closed because the implementation "looks right".
- Do not leave destructive behavior guarded only by optimistic assumptions.
- Do not introduce a compatibility shim or dual-write design unless a correction
  from Codex explicitly changes the roadmap.
- If a command cannot run, document the blocker and add a reproducible fallback
  when possible.

## Required Gates

Before Done, run or explicitly classify the base gates:

```text
pnpm i
pnpm build
just typecheck
just test-all
just lint-all
pnpm audit --audit-level moderate
git diff --check
```

Also run the domain gates for the lanes touched in the run:

```text
pnpm typecheck
pnpm test
pnpm lint
just e2e-up
just e2e
just e2e-cli
just e2e-down
```

Focused lane gates must be recorded in `gates.md` and the matching
`evidence/lane-XX.md`. The lane documents in `docs/rearch-2/` are the source of
truth for the exact acceptance criteria.

## Reviewer Expectations

Codex will use reviewer subagents after material changes and at lane boundaries.
Expect review scopes like:

- `prosa-architect` for bundle schema, canonical graph, CAS, raw preservation,
  and type-level contracts.
- `prosa-importer-specialist` for provider importers, source preservation,
  fixture parity, and idempotency.
- `prosa-cli-search-specialist` for CLI, MCP, read APIs, search, analytics, TUI,
  and export parity.
- `prosa-server-sync-specialist` for API server, Postgres schema, sync protocol,
  auth, object storage, and Docker harness.
- `ralph-loop-promotion-integrity-reviewer` for manifests, receipts, CAS,
  idempotency, cleanup, audit, and migration safety.
- `ralph-loop-security-reviewer` for auth, tenant isolation, device ownership,
  object routes, and production config.
- `ralph-loop-remote-read-reviewer` for receipt-pinned reads, CLI parity, and
  fail-closed behavior.
- `ralph-loop-e2e-gate-runner` before final completion or server-sync cutover
  points.

Reviewer findings that can break product behavior, security, data integrity,
parity, or release gates become blocking corrections in `correction-queue.md`.

## Completion Rule

Only satisfy the completion promise when the statement is true. With the Ralph
Loop plugin, that means outputting exactly:

```text
<promise>RALPH_DONE</promise>
```

when every lane is implemented, every blocking correction is closed with
evidence, required gates are green or classified, and the worktree state is
documented.

Before outputting `RALPH_DONE`, you must also complete the final stabilization
wait:

1. Confirm there are no open blocking corrections and no unexplained dirty
   worktree changes.
2. Run or record the required gates.
3. Perform five consecutive clean cycles:
   - sleep exactly 180 seconds;
   - reread `correction-queue.md`, `gates.md`, `status.md`,
     `git status --short --branch`, and recent commits;
   - if any blocker, failed gate, stale evidence, new commit, or unexplained
     dirty worktree state appears, fix it and reset the cycle count to zero;
   - otherwise count that as one clean cycle.
4. Only after five clean cycles, minimum 15 minutes, may you output
   `RALPH_DONE`.

Do not output `RALPH_DONE` immediately after closing a correction or making a
commit. Missing stabilization evidence is a false completion.
