# Ralph Loop: rearch-2

You are implementing Prosa v2 from the lean execution plan in `docs/rearch-2/`
on branch `feature/rearch`.

Codex is acting as architect and gatekeeper. It may update correction and gate
files while you work. Treat those files as blocking input.

Codex will actively review your code with focused subagents and steer this run
through `correction-queue.md`, `gates.md`, and updates to this prompt. Those
review findings are part of the implementation contract, not optional advice.
Expect Codex to reject `RALPH_DONE` if subagent findings remain open.

This is a very large feature. Work strictly lane by lane. Lane 1 is accepted
with the re-scopes recorded in `docs/rearch-2/lane-1-rescopes.md`; Lane 2 is
accepted by Codex/governor as of 2026-05-19; Lane 3 is active. If one Ralph
Loop iteration cannot complete the entire roadmap, leave accurate status and
evidence for completed work. Do not output `RALPH_DONE` unless every lane below
is complete and all required gates and stabilization steps have run.

## Invocation Contract

This prompt is intentionally self-contained. When Ralph is launched with
`/ralph-loop:ralph-loop @docs/roadmap/rearch-2/ralph-loop-prompt.md`, treat this
section as the full restart instruction:

- Read this prompt, `docs/roadmap/rearch-2/correction-queue.md`,
  `docs/roadmap/rearch-2/gates.md`, `docs/roadmap/rearch-2/status.md`, and
  `docs/rearch-2/03-lane-2-importers.md`.
- User direction: Lane 1 is accepted. Lane 2 is formally accepted by
  Codex/governor. Its implementation contract is complete (5 providers
  + fixture corpora + projection-id idempotency +
  per-provider bundle-compile idempotency that exercises Reserve and
  asserts on-disk pack stability). Lane 3 derived-layer scaffold has
  landed in its own focused commit on top of the Lane 2 closeout per
  `CQ-083`.
- All `CQ-074..CQ-103` are closed. Lane 3 progress includes the
  `loadSessionBlobPack` on-disk loader (`eb88037`) with CQ-098
  intermediate-symlink containment (`ea5f5d1`), production zstd
  codec (`62550e1`), SessionBlob listing helpers + shared
  containment refactor + CQ-099 resolver-parity (`f8a2b7a`),
  `loadLatestSessionBlobPack` latest-epoch loader (`f0a6ba7`),
  `loadTranscriptFromBundle` end-to-end loader + CQ-100
  input-validation-before-listing (`d9dfc19`),
  `iterateTranscriptFromBundle` streaming counterpart (`c1a2836`),
  `listAllSessionBlobSessions` cross-epoch union (`b5ea97c`),
  `readSessionBlobHeader` header-only reader (`2c993ae`),
  `sessionBlobPackExists` cheap probe (`9dc147b`),
  `latestEpochForSession` epoch-only lookup (`85931e2`),
  `getSessionBlobSummary` aggregate inventory row (`21ce057`),
  `listSessionBlobSummaries` bulk inventory listing (`d8e1e5c`),
  `tantivyIndexStatus` read-only status snapshot (`584029d`),
  `analyticsViewsDescriptor` catalog packager (`09ca11e`),
  `bundleDerivedStatus` top-level aggregator (`1cf6c95`),
  `listProjectionSegments` Parquet segment listing (`50c901e`),
  `summariseProjectionSegments` rollup (`15a975a`), SessionBlob
  read-side end-to-end integration test (`aac58e9`), compaction
  read-side end-to-end integration test (`447f60c`), Tantivy
  read-side end-to-end integration test (`784c1e0`),
  projection-segments preemptive containment hardening + CQ-101
  planner-refactor closeout (`668f473`), CQ-102 planner/execution
  containment evidence + `index.ts` public-API docs (`c467d40`),
  CQ-103 Tantivy checkpoint read/write symlink containment
  (`8c241a4`), `derivedLayerEpochsTouched` cross-subsystem epoch
  union (`60cae8a`), CQ-104 artifact-bearing-epoch filter
  closeout (`8330d82`), `prosa index-v2 status` CLI surface
  (`17243a1`), `prosa index-v2 sessions` inventory subcommand
  (`30a1d80`), `prosa index-v2 transcript` JSON-form transcript
  subcommand (`5530de1`), `prosa index-v2 epochs` audit/GC
  epochs-touched subcommand (`e33d63a`), `prosa index-v2
  compaction-plan` Parquet compaction planner subcommand
  (`379004f`), `prosa index-v2 analytics-views` view-catalog
  subcommand (`a557453`), `prosa index-v2 projection-segments`
  Parquet segments listing + summary subcommand (`018f4c6`),
  `prosa index-v2 tantivy-rebuild-plan` rebuild-state-machine
  subcommand (`cb30640`), `prosa index-v2
  analytics-execution-plan` DuckDB statement-sequence
  subcommand (`5842aa0`), `prosa index-v2
  compaction-execution-plan` Parquet COPY-statement subcommand
  (`a0ac05b`), `prosa index-v2 transcript-header` SessionBlob
  header-only probe subcommand (`278b4a1`),
  `formatTranscriptTextV2` v2 text renderer + `prosa index-v2
  transcript --format text|json` flag + CQ-105 pre-read format
  validation (`4a754ad`), `formatTranscriptMarkdownV2` + `prosa
  index-v2 transcript --format markdown` flag + CQ-106
  fence-escalation closeout (`a837676`), `prosa index-v2
  transcript --start-ordinal/--end-ordinal` range flags
  (`2c37af6`), `loadTranscriptFromBundle({ epoch })` + `prosa
  index-v2 transcript --epoch <n>` historical-pack selector
  (`f890091`), `iterateTranscriptFromBundle({ epoch })`
  streaming-side symmetry (`dcad4d7`), `prosa index-v2 sessions
  --session-id <id>` single-session filter via
  `getSessionBlobSummary` (`5020c3e`),
  `apps/cli/test/cli/index-v2-coherence.test.ts` cross-subcommand
  coherence test (`1dff6ab`), `buildCompactManifestV2` + `prosa
  index-v2 compaction-manifest` Lane 3 `compact.manifest.cbor`
  deliverable (`f39d1da`), `verifyAllSessionBlobPacks` + `prosa
  index-v2 verify-packs` bundle-wide integrity audit
  (`d5ea090`), `prosa index-v2 tantivy-schema`
  schema-introspection subcommand (`343e148`),
  `writeCompactManifestV2` + `readCompactManifestV2` +
  `compactManifestPath` on-disk manifest persistence
  (`09737e9`), CQ-107 deep-validation closeout on the
  manifest reader (`1568e1c`), `prosa index-v2
  compaction-manifest --write` / `--read` CLI surface
  (`ed379a1`), `listSupersededSegmentsFromManifests` +
  `summariseSupersededSegments` + `prosa index-v2
  superseded-segments` audit/GC primitive (`633ee9b`),
  `listCompactedOutputs` + `prosa index-v2 compacted-outputs`
  manifest-vs-on-disk consistency audit (`6b36ff1`), CQ-109
  compact-manifest path-safety closeout (`4f91cfb`),
  `planSupersededCleanup` + `prosa index-v2 gc-plan`
  safe-to-delete GC planner (`14c98cb`),
  `apps/cli/test/cli/index-v2-compaction-lifecycle.test.ts`
  end-to-end compaction-lifecycle audit test (`55b435f`),
  `derivedLayerMaintenanceSummary` + `prosa index-v2
  maintenance` one-call dashboard read (`64e1d4e`),
  maintenance ↔ discrete-subcommand rollup-equality coherence
  test (`20687c9`), `recommendMaintenanceActions` prescriptive
  layer + `prosa index-v2 next-action` CLI subcommand + CQ-111
  GC-suppress-when-inconsistent safety closeout (`c61be83`),
  `planGcExecution` GC execution-plan composer + `prosa
  index-v2 gc-execution-plan` CLI subcommand (`a2d711c`),
  `summariseCompactionEffectiveness` per-seq bytes-in vs
  bytes-out rollup + `prosa index-v2 compaction-effectiveness`
  CLI subcommand (`d471467`), `listCompactionHistory`
  per-manifest timeline + `prosa index-v2 compaction-history`
  CLI subcommand (`b07a36c`),
  `summariseDerivedLayerFootprint` per-subsystem byte/file
  rollup + `prosa index-v2 footprint` CLI subcommand
  (`4169477`), `derivedLayerCapabilities` content-free
  introspection composer + `prosa index-v2 capabilities` CLI
  subcommand (`7a4bcb4`), `derivedLayerSnapshot` MCP-friendly
  bulk read + `prosa index-v2 snapshot` CLI subcommand
  (`ad8d227`), CQ-113 closeout (snapshot test split: positive
  composition + explicit malformed-checkpoint fail-closed)
  (`b64141e`), `prosa index-v2 derived-layout` path-
  introspection subcommand (`2a5a99f`),
  `detectCompactionOverlaps` cross-seq correctness audit +
  `prosa index-v2 compaction-overlaps` CLI subcommand
  (`9033b5b`), maintenance + recommendations corruption gate
  wiring `overlaps: { count, paths }` into the maintenance
  summary and adding the highest-priority `resolve_overlap`
  recommendation that short-circuits every other action
  (pending commit), plus the prior scaffold
  (`bb76006`), SessionBlobPackV2 byte layout (`ba87f05`), Parquet
  compaction planner (`ea8c1a8`), DuckDB analytics view shape contract
  + compacted-overlay binding (`cff3670` / `e35f844`), Tantivy schema
  + rebuild planner state machine (`509e1f1`), SessionBlob projection
  bridge / transcript iterator (`585a456` / `c7e027d`), Tantivy
  checkpoint persistence + atomic replacement (`9ebbd07` / `734b958`),
  analytics execution-plan composer (`3f54ca6`), Tantivy index-dir
  probe + final-component symlink rejection (`8d45fbb` / `2c97eca`),
  bundle-aware Tantivy rebuild orchestration (`fa49eb2`) with roadmap
  reconciliation at `e1e432d`, compaction execution-plan composer
  (`87bacb0`), `derivedPaths` centralised layout (`d3811b4`),
  `clearTantivyIndexDir` reset helper (`257a176`), CQ-096
  intermediate-symlink containment (`3be300f`), and SessionBlob
  pack-path resolver + CQ-097 textual-source cleanup (`d798b15`).
  All `CQ-074..CQ-114` are closed. `CQ-113` closeout split the
  snapshot composition test from the malformed-checkpoint
  fail-closed assertion: the positive test plants two valid
  Tantivy segment files; a new negative test pins
  `/readIndexCheckpoint.*malformed JSON/`. `CQ-112` closeout pushed the
  top-level `derived/` scan to enumerate every direct child, route
  unknown regular files into `other`, and refuse unknown top-level
  symlinks with a deterministic `(CQ-112)` error before returning.
  There is no remaining Lane 2 external-acceptance blocker; do not
  output `RALPH_DONE` yet because Lane 3 remainder (Tantivy native
  writer, DuckDB runtime executor, runtime Parquet merge) plus
  Lanes 4–10 are still incomplete.
- Continue from the first incomplete Lane 3 surface after `784c1e0`.
  Do not restart an already completed lane.
- If a correction needs a Codex/governor decision, ask one clear binary
  accept/reject question with a safe default. Do not loop on "external
  acceptance" as if Codex were unavailable.
- If no blocking correction remains, run the mandatory final stabilization
  wait: five clean cycles of sleep 180 seconds, then reread correction queue,
  gates, status, git status, and recent commits.
- Output `RALPH_DONE` only after all lanes are complete, all blockers are
  closed, required gates pass or are classified, and the five cycles stay clean.

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
  higher priority than new feature work unless that correction explicitly
  permits independent non-conflicting progress;
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

Current open corrections: `CQ-113` — snapshot WIP must not plant
malformed Tantivy checkpoint JSON in a test that expects
`derivedLayerSnapshot()` to succeed. `CQ-091`..`CQ-112` are all closed.
`CQ-104` closeout: `derivedLayerEpochsTouched()` now filters SessionBlob
candidate epochs through `listSessionBlobSessions({ bundleRoot, epoch })` and
counts only epochs with actual packs, while projection segment epochs still come
from `listProjectionSegments()`. Empty SessionBlob epoch directories no longer
over-report the audit/GC keep-set, and the projection-overlap regression
confirms projection-only artifacts still surface.

Lane 2 is accepted by Codex/governor as of 2026-05-19; do not ask again for
Lane 2 external acceptance and do not block Lane 3 on it. Lane 3 forward work
continues on the remaining surfaces (Tantivy native writer, DuckDB runtime
executor, Parquet merge worker).

Lane 0 + Lane 1 are accepted by the project owner on 2026-05-18, including the
two re-scopes in `docs/rearch-2/lane-1-rescopes.md`.

Lane 2 (importers) is accepted. The orchestrator,
`GraphResolver`, and mock-provider tests landed at `004107c`. Minimal
provider slices: `fc66925` (Codex), `8c0ba5f` (Claude), `aa88079`
(Claude spawned edges + Cursor), `c496bac` (Gemini + Hermes + Cursor
logical-key fix). CLI help-smoke closeout: `58cca83`. Full per-record
projection: `d302bc6` (Codex), `7eaed27` (Claude), `b660f44` (Gemini),
`8c1714f` (Hermes), `af27eba` (Cursor over a real SQLite reader). **This
iteration** lands the Lane 2 closeout: shared fixture corpora under
`test/fixtures/providers-v2/` and the cross-provider idempotency
conformance suite at `test/conformance/providers-v2-idempotency.test.ts`,
plus the root `better-sqlite3` / `@types/better-sqlite3` devDependency
the conformance test needs. Closes `CQ-074` + `CQ-079` + `CQ-080`. This
lane is accepted and no longer has a pending Codex/governor/user
sign-off gate.

Lane 3 (derived layer) is the active lane. The scaffold commit on top
of the Lane 2 closeout adds `packages/prosa-derived-v2/` with the
SessionBlobPackV2 joint-constraint policy and the Parquet compaction
trigger policy plus 17 focused unit tests; subsequent iterations
bring the Tantivy generation writer, SessionBlobPackV2 byte layout
(writer + reader), DuckDB analytics view definitions, and the
runtime compaction worker. Subsequent lanes (4 server beyond DB
scaffold, 5 sync protocol, 6 read API, 7 CLI+MCP, 8 audit+GC, 9
migration, 10 cutover) remain unstarted.

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
