# Lane Evidence

Lane: 03 - Derived layer
Status: active WIP — scaffold (`bb76006`) + SessionBlobPackV2 byte layout
(framing + writer + reader + verifier) landing in this iteration close
`CQ-084` and `CQ-085`. Tantivy writer, DuckDB analytics view definitions,
and the runtime compaction worker still pending.
Owner: Ralph
Commit range: Lane 3 scaffold (`bb76006`) + SessionBlobPackV2 byte-layout
slice (this iteration) on top of the Lane 2 `CQ-082` closeout (`3eb1c08`).

## Acceptance Criteria

- [x] `packages/prosa-derived-v2` scaffolded as a workspace package with
  `tsup` build, `vitest` test, Biome lint, and the standard `prosa-dev`
  source-condition export. Depends on `@c3-oss/prosa-bundle-v2` +
  `@c3-oss/prosa-types-v2`.
- [x] SessionBlobPackV2 joint-constraint policy implemented and tested:
  - `decideBlock(page, blockBytes)` returns `inline`, `cas_ref`
    (`oversize` / `page_would_be_empty`), or `split_page` per the lean
    profile caps (1 MiB page payload, 32 KiB per inline block, 256
    hard messages/page, 128 target messages/page).
  - `decideMessageBoundary(page)` returns `append` or `split_page`
    (`hard_message_cap` / `target_byte_budget`).
  - Simulated 5,000-small-message session paginates without
    overflowing either cap.
- [x] Compaction trigger policy implemented and tested:
  - `compactionDecision(segments)` fires on `file_count_trigger`
    when > 32 small segments exist, and on
    `low_count_byte_ceiling` when 17–32 small files weigh under
    256 MiB total. Large (≥ 32 MiB) segments are excluded from the
    "small" count.
- [x] Parquet compaction planner: `planCompaction(bundleRoot)` walks
  `epochs/<n>/projection/*.parquet`, groups segments per canonical
  entity name, applies `compactionDecision`, and emits a deterministic
  `CompactionPlan` naming exactly which segments would be merged into
  `epochs/compact-<NNNN>/projection/<entity>.compacted.parquet`.
  Already-compacted directories are skipped on re-run, sequence
  numbers auto-discover from existing `compact-NNNN/`, and
  non-numeric epoch entries are ignored. The actual row-preserving
  Parquet merge (runtime worker) still lands in a follow-up
  iteration when a Parquet writer is wired up.
- [/] Tantivy generation writer + incremental rebuild — schema +
  fingerprint + rebuild planner + checkpoint state-machine +
  checkpoint persistence landed in
  `src/tantivy/{schema,rebuild-plan,checkpoint-store}.ts`. The
  actual Tantivy writer that opens the on-disk index (via
  `@oxdev03/node-tantivy-binding`) lands when the native dep is
  added to the workspace allowlist. `currentTantivySchemaFingerprint()`
  is `blake3` (v2 hash convention) over the pinned field/tokenizer
  list. `planTantivyRebuild` decides `skip` / `incremental` /
  `full` purely from inputs, never touches the filesystem;
  reasons are enumerated: `no_prior_index`,
  `fingerprint_mismatch`, `caller_requested_overwrite`,
  `index_dir_invalid`, `prior_run_failed` (full),
  `fingerprint_match_with_new_rows` (incremental),
  `already_indexed_up_to_date` (skip).
  `checkpointAfterRebuild` / `checkpointAfterFailure` return a new
  `IndexCheckpointV2` without mutating prior state.
  `readIndexCheckpoint` / `writeIndexCheckpoint` /
  `readIndexCheckpointOrEmpty` persist that state at
  `<bundleRoot>/derived/tantivy/checkpoint.json` as canonical JSON
  (sorted keys, no whitespace). Writes are rename-based atomic
  (CQ-093): canonical bytes go to a same-directory temp file
  (`checkpoint.json.tmp.<pid>.<rand>`), the file is fsynced, then
  `rename(tmp, checkpoint.json)` (POSIX atomic on the same
  filesystem) is followed by `syncDir(dirname(path))` so the
  rename survives a crash. A torn write cannot leave the final
  path partially written; readers always observe either the
  prior good checkpoint or the new one. Two equivalent
  checkpoints still write byte-identical files because the bytes
  are canonical JSON. Read-side validates field types and rejects
  unexpected `status` values rather than papering over corrupt
  state with the empty checkpoint. CQ-093 regression coverage
  plants a stale `.tmp.*` from a simulated interrupted prior
  update and asserts both the prior good checkpoint and the
  follow-up write are readable without temp-file leaks.
- [x] SessionBlobPackV2 projection-to-input bridge
  (`projectionToSessionBlobInputs`) converts a session's canonical
  `MessageV2[]` + `ContentBlockV2[]` (+ optional `ToolCallV2[]`)
  rows into the ordered `BlobMessageInput[]` shape the writer
  consumes. Pure-TypeScript glue: deterministic sort by
  (`ordinal`, secondary id), session_id filtering so cross-session
  leakage is dropped, `text_object_id` → `cas_ref` body /
  `text_inline` → `inline` body classification, `is_tool_call`
  flag tagging from `ToolCallV2.message_id` back-reference. Round-
  trips through `writeSessionBlobPack` end-to-end with the
  identity compressor. CAS-ref previews are truncated by UTF-8
  byte length (CQ-091): `truncateToUtf8Bytes` uses
  `TextEncoder.encodeInto` so multibyte scalars are never split
  and the returned `byte_length` matches the truncated preview's
  actual UTF-8 size. The writer's CAS-ref `bodyByteCost` matches:
  `utf8ByteLength(body.preview)` × 1.1 + 128 + JSON overhead. Two
  regression tests guard the property: (a) a 4096-emoji
  `text_inline` paired with `text_object_id` caps the emitted
  preview to ≤ `CAS_REF_PREVIEW_MAX_BYTES` UTF-8 bytes; (b) 128
  multibyte CAS-ref blocks never produce a page with
  `uncompressed_length > MAX_PAGE_UNCOMPRESSED_BYTES`. The
  runtime derived layer plugs this bridge between Lane 2's
  per-epoch projection and Lane 3's session-blob writer.
- [x] SessionBlobPackV2 cross-page transcript iterator
  (`iterateTranscript` + `loadTranscript`) walks every message in a
  pack in canonical ordinal order, coalescing fragments that share
  `(message_id, ordinal)` across adjacent pages back into a single
  `TranscriptMessage` so callers see whole messages even for
  adversarial single-message-too-large input. Pages outside the
  caller's `[startOrdinal, endOrdinal]` window are skipped without
  decompression; per-page hashes are verified via
  `loadTranscriptPage`. The generator form supports early
  termination so paged-render flows do not pay for unread pages.
  7 tests cover empty pack, single-page ordinal walk, multi-page
  ordinal walk, fragment-mode coalescing on the CQ-085 400-block
  fixture (block-id order end-to-end), range filters (head /
  middle / tail / empty-window-above-last-ordinal), lazy
  termination, and tampered-payload hash rejection.
- [x] SessionBlobPackV2 byte layout (writer + reader emitting and
  parsing the actual pack format) implemented and tested:
  - 16-byte framing magic `PROSA_SESS_PACK2` mirroring the
    `prosa-bundle-v2` `PROSA_CAS_PACK_2` / `PROSA_RAW_SRC_V2`
    convention; canonical-JSON header bound by blake3.
  - `writeSessionBlobPack` paginates per the joint constraint,
    keeps multi-block messages atomic on a single page when they
    fit, and falls back to fragment mode for adversarial
    single-message-too-large inputs while preserving every block id.
  - `pack_digest` is defined as `blake3(canonical(header_without_pack_digest_field) || payload)`;
    `verifyPackDigest()` recomputes it from the bytes alone for
    tamper detection.
  - `loadTranscriptPage` validates both `stored_hash` (compressed)
    and `uncompressed_hash` before returning the parsed body.
  - Identity compressor/decompressor pair lets tests exercise the
    layout independently of zstd; production callers will plug in
    `zstdCompress` / `zstdDecompress` from `@c3-oss/prosa-bundle-v2`.
- [x] Tantivy rebuild orchestration helper
  (`planTantivyRebuildFromBundle({ bundleRoot, currentMaxRowid,
  overwriteRequested? })`) wraps the two filesystem reads
  (`readIndexCheckpointOrEmpty` + `tantivyIndexDirIsValid`) and the
  pure planner (`planTantivyRebuild`) into one async call.
  Returns `{ plan, checkpoint, indexDirValid }` so callers can
  chain `checkpointAfterRebuild` / `checkpointAfterFailure`
  without re-reading state. No writes; corrupt-checkpoint errors
  from `readIndexCheckpointOrEmpty` propagate unchanged so the
  planner cannot paper over corruption with
  `EMPTY_INDEX_CHECKPOINT`. 9 tests cover every reachable planner
  branch through the orchestration path: fresh bundle (no
  checkpoint, no dir), valid dir + no checkpoint
  (`no_prior_index`), `skip` / `incremental` / `fingerprint_mismatch`,
  `caller_requested_overwrite`, `index_dir_invalid` (checkpoint
  exists but dir is gone), `prior_run_failed`, and corrupt-checkpoint
  error propagation.
- [x] Tantivy index-dir best-effort probe
  (`tantivyIndexDir(bundleRoot)`, `tantivyMetaPath(bundleRoot)`,
  `tantivyIndexDirIsValid(bundleRoot)`) is the filesystem side of
  the rebuild planner's `indexDirValid` boolean. The probe uses
  `lstat()` on both the directory and `meta.json` so a symlink at
  either path is rejected unconditionally regardless of the link
  target (CQ-094) — a planted
  `derived/tantivy/index -> /etc/passwd.d` cannot be reported as a
  recoverable index. It returns `true` only when the canonical
  `<bundleRoot>/derived/tantivy/index` is a real directory
  containing a real regular `meta.json` that parses as a JSON
  object with an array-typed `segments` field. Every other state
  — ENOENT, file-not-dir, malformed JSON, JSON-array root, missing
  `segments`, non-array `segments`, dangling symlink, escape-path
  symlinks at either index or meta — returns `false`. Deeper
  integrity checks remain the native writer's responsibility; the
  probe is deliberately ENOENT-tolerant and cheap so the planner
  can keep its decision pure-TS.
- [x] Derived-layer directory-layout module (`derivedPaths(root)`,
  `derivedRoot(root)`) centralises the on-disk layout under
  `<bundleRoot>/derived/` so every Lane 3 surface reads paths from
  a single typed object. Mirrors the bundle-v2 `bundlePaths(root)`
  pattern. The existing per-feature getters (`tantivyIndexDir`,
  `tantivyMetaPath`, `tantivyCheckpointPath`) now delegate to
  `derivedPaths` rather than hardcoding the relative segments, so
  the layout has a single source of truth and a single edit point
  when future features (session-blob packs, analytics runtime
  scratch, runtime Parquet merge) need new directories. 7 tests
  pin every canonical path, assert `derivedRoot` parity, assert
  the three Tantivy delegates do not drift from the typed layout,
  and verify relative bundle roots are composed without
  `path.resolve()`.
- [x] Compaction execution-plan composer
  (`planCompactionExecution({ bundleRoot, plan })`) turns a
  `CompactionPlan` from `planCompaction()` into the ordered DuckDB
  statement sequence the runtime worker will execute. Each entity
  in the plan yields one
  `COPY (SELECT * FROM read_parquet([<absolute_seg1>, ...],
  union_by_name => true)) TO '<absolute_output>' (FORMAT 'parquet',
  CODEC 'zstd');` statement. The result exposes `outputAbsPath` +
  `outputDir` per entity so the runtime worker can `mkdir -p` the
  parent before executing the COPY. Pure composition — no DuckDB
  connection opens, no filesystem writes. Single-quote escaping is
  applied to every embedded path so a pathological bundle root
  cannot break the SQL string literal. 8 tests cover empty plan,
  one COPY per entity in plan order, absolute segment globs,
  absolute output path with zstd Parquet, single-quote escaping in
  bundle root, determinism across calls, segment-order
  preservation (oldest epoch first), and source-plan passthrough.
- [x] Analytics execution-plan composer
  (`planAnalyticsExecution(input)`) returns the ordered statement
  sequence a runtime DuckDB executor consumes to materialise an
  analytics view and run a report query against it. The plan
  ships:
  - `view` + `columns` locked to `ANALYTICS_VIEW_COLUMNS[view]` so
    the runtime cannot drift from the column-shape contract;
  - one `CREATE OR REPLACE TEMP VIEW` per `ANALYTICS_ENTITY_TABLES`
    binding the live + compacted-overlay Parquet read;
  - the `CREATE OR REPLACE VIEW <view> AS ...` body from
    `analyticsViewSql(view)`, terminated with a single `;`;
  - a default `reportQuery` of `SELECT * FROM <view>;`, replaceable
    verbatim by the caller for ad-hoc reports.
  Pure composition — no DuckDB connection opens; the runtime
  executor lands separately when `@duckdb/node-api` is wired into
  the package. 9 tests cover column-shape contract, preamble entity
  order, view-body terminator handling, default + custom report
  queries, bundle-root binding across both Parquet globs, unknown
  view rejection, determinism, and single-quote escaping in the
  bundle root.
- [x] DuckDB analytics view definitions (5 fixed reports) — SQL
  bodies and column-shape contract land in
  `src/analytics/views.ts`. `ANALYTICS_VIEW_NAMES` /
  `ANALYTICS_VIEW_COLUMNS` lock the canonical names + ordered
  column lists; `analyticsViewSql(name)` returns the DuckDB
  `CREATE OR REPLACE VIEW ... AS ...` body; `parquetReadFor` and
  `analyticsParquetPreamble` build the Parquet-source temp views
  the runtime binds before executing the view bodies. Each body
  is a DuckDB port of the v1 statement: `julianday` → `EPOCH(::TIMESTAMP)`,
  `is_error = 1` → `is_error` boolean, `CAST(x AS TEXT)` removed
  where unnecessary. The runtime executor that actually opens a
  DuckDB connection and runs the SQL lands in a follow-up when
  `@duckdb/node-api` is wired into the package.
- [ ] Runtime Parquet compaction worker invoking the policy at the
  end of compile — pending.
- [ ] `prosa index-v2 tantivy`, `prosa index-v2 status`, and `prosa
  export-v2 parquet` CLI commands — pending Lane 7 surfaces but core
  functions land in this lane.

## Implementation Notes

- Source contract: `docs/rearch-2/04-lane-3-derived-layer.md`.
- The scaffold commit ships pure-TypeScript policy modules (no
  Tantivy or DuckDB dependencies yet). Subsequent iterations bring in
  `@oxdev03/node-tantivy-binding` and `@duckdb/node-api` mirroring
  the v1 derived layer's surface.
- `src/session-blob/writer-policy.ts` is deliberately a pure decision
  function so the actual pack writer (which streams CBOR + zstd
  output) can plug into it without rewriting the cap math.

## Commands Run

```text
pnpm install --prefer-offline                       # registers @c3-oss/prosa-derived-v2 in pnpm-lock.yaml
pnpm --filter @c3-oss/prosa-derived-v2 typecheck    # clean
pnpm --filter @c3-oss/prosa-derived-v2 test         # 146 tests / 16 files (writer-policy 11, compaction 6, framing 8, writer/reader 11, compaction planner 8, compaction executor-plan 8, analytics views 11, tantivy schema 7, tantivy rebuild-plan 10, projection-bridge 9, reader-iterator 7, tantivy checkpoint-store 11, analytics executor-plan 9, tantivy index-dir probe 14, tantivy plan-bundle orchestration 9, derived-layout 7)
pnpm --filter @c3-oss/prosa-derived-v2 lint         # clean
pnpm build                                          # 13/13 turbo
pnpm typecheck                                      # 13/13 turbo
pnpm test                                           # 13/13 turbo
pnpm lint                                           # 13/13 turbo
pnpm test:conformance                               # 26 tests / 2 files (unchanged from Lane 2 closeout)
git diff --check                                    # clean
```

## Data / Security Evidence

- Derived artifacts are never authoritative; the lane-doc contract
  pins `bundleRoot` to row content (not file bytes) so compaction
  cannot mutate the canonical Merkle root.
- The writer-policy implementation never inlines a block larger than
  `MAX_INLINE_BLOCK_BYTES` and never emits a single-block page that
  exceeds `MAX_PAGE_UNCOMPRESSED_BYTES`; the 5,000-message
  simulation test enforces both caps after every commit.

## Known Risks

- Column drift in analytics and oversized transcript pages can break
  downstream CLI, MCP, and web reads. The joint-constraint test
  catches per-block oversize and per-page overflow; analytics column
  drift will be caught by snapshot fixtures when the view definitions
  land.

## Reviewer Notes

- Pending `prosa-cli-search-specialist` and `prosa-architect` review
  after the Tantivy writer + DuckDB views land. The scaffold is a
  pure-TypeScript foundation; further iterations bring native deps.
