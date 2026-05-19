# Lane Evidence

Lane: 03 - Derived layer
Status: active WIP — scaffold (`bb76006`) + SessionBlobPackV2 byte layout
(framing + writer + reader + verifier) close `CQ-084` and `CQ-085`;
additional Lane 3 planner/helper slices landed through `d798b15`.
`CQ-096` intermediate symlink containment landed at `3be300f`.
`CQ-097` SessionBlob layout textual-source cleanup landed at
`d798b15` (paired with the SessionBlob pack-path resolver in the
same slice). `loadSessionBlobPack` landed at `eb88037` with the CQ-098
intermediate-symlink containment fix at `ea5f5d1`.
Production zstd landed at `62550e1`. SessionBlob listing helpers +
shared containment refactor + CQ-099 resolver-parity landed at
`f8a2b7a`. `loadLatestSessionBlobPack` landed at `f0a6ba7`.
`loadTranscriptFromBundle` end-to-end loader + CQ-100
input-validation-before-listing fix landed at `d9dfc19`.
Tantivy writer, DuckDB analytics view definitions, and the runtime
compaction worker still pending.
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
  recoverable index. CQ-096 extends the symlink-rejection contract
  to intermediate components: `<bundleRoot>/derived` and
  `<bundleRoot>/derived/tantivy` are also walked with `lstat()` and
  a symlink at either resolves the probe to `false`. The shared
  helper `detectDerivedTantivyIntermediateSymlink(bundleRoot)`
  encapsulates the intermediate walk; it is also consumed by
  `clearTantivyIndexDir` so the probe and the reset agree on what
  counts as containment. Bundle-root containment is **not**
  validated — opening a bundle through a symlinked alias remains a
  supported deployment pattern. The probe returns `true` only when
  the canonical `<bundleRoot>/derived/tantivy/index` is a real
  directory containing a real regular `meta.json` that parses as a
  JSON object with an array-typed `segments` field. Every other
  state — ENOENT, file-not-dir, malformed JSON, JSON-array root,
  missing `segments`, non-array `segments`, dangling symlink,
  escape-path symlinks at the final or any intermediate component —
  returns `false`. Deeper integrity checks remain the native
  writer's responsibility; the probe is deliberately ENOENT-tolerant
  and cheap so the planner can keep its decision pure-TS. CQ-096
  regression coverage adds three tests on top of the CQ-094 set:
  `derived/tantivy` symlinked to an external dir with a valid
  index/meta returns `false`; `derived` symlinked similarly returns
  `false`; bundle opened via a symlinked alias with a real derived
  tree returns `true`.
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
- [x] SessionBlobPackV2 streaming end-to-end transcript loader
  (`iterateTranscriptFromBundle({ bundleRoot, sessionId, range?,
  decompress? })`) parallels the collect-all `loadTranscriptFromBundle`
  but returns a pull-based `Generator<TranscriptMessage>` instead
  of a fully materialised array. Same surface
  (`{ epoch, path, pack_digest, messages }`), same validation +
  containment + tamper-detection guarantees. Pack load + digest
  verification happen eagerly; per-page decompression is deferred to
  the generator so paged-render flows (TUI scrolling, MCP streaming
  responses, web pagination) can `break` after the rendered slice
  without paying decompression cost for unread pages. 9 tests cover:
  streaming round-trip with the production zstd default, newest-wins
  selection, ordinal range filter applied lazily, lazy termination
  via early break (500-message pack consumed after 5 yields),
  ENOENT propagation, CQ-100 sync invalid-sessionId rejection,
  custom decompressor override (identity), CQ-098 intermediate-
  symlink propagation, and metadata-shape parity with the collect-
  all loader.
- [x] SessionBlobPackV2 end-to-end transcript loader
  (`loadTranscriptFromBundle({ bundleRoot, sessionId, range?,
  decompress? })`) gives CLI/MCP/web read surfaces a one-call read
  path from `(bundleRoot, sessionId)` → `TranscriptMessage[]`. It
  composes `loadLatestSessionBlobPack` (newest-epoch selection +
  pack-digest re-verification) with `loadTranscript` (per-page
  hash verification + multi-page fragment coalescing + optional
  ordinal range filter) and defaults the decompressor to the
  production `zstdSessionBlobDecompressor`. Result exposes
  `{ epoch, path, pack_digest, messages }`. Callers may pass a
  custom decompressor for non-zstd packs (tests use the identity
  pair); range filtering keeps out-of-range pages from being
  decompressed. 8 tests cover: small zstd round-trip,
  newest-wins selection across [1, 4, 9], ordinal range filter
  yielding only the intersecting slice, session-not-found
  ENOENT, custom decompressor override (identity), sync sessionId
  validation, CQ-098 propagation from the latest loader, and the
  `pack_digest` field shape (`/^blake3:[0-9a-f]{64}$/`).
- [x] SessionBlobPackV2 latest-epoch loader
  (`loadLatestSessionBlobPack({ bundleRoot, sessionId })`) gives the
  CLI/MCP/web read surfaces a single-call materialisation path that
  does not require the caller to know which epoch last touched a
  session. It composes `listSessionBlobEpochs` (newest → oldest walk)
  with `loadSessionBlobPack` per epoch, returning the first epoch's
  pack that decodes plus the `epoch` number in the result. ENOENT
  at a per-epoch attempt is treated as "skip and try older"; every
  other failure (CQ-094 final-component symlink, CQ-098
  intermediate-symlink, non-regular-file, `verifyPackDigest`
  tamper) propagates immediately so the fallback walk cannot mask
  data-integrity violations. The "no pack anywhere" case throws an
  Error with `code: 'ENOENT'` so callers distinguish "session
  never written" from corruption. 10 tests cover: single-epoch
  return, newest-wins selection across [1, 3, 7], skip-empty-newer
  fallback, holes in the epoch sequence ([0, 5]), session-not-found
  ENOENT, fresh-bundle ENOENT, sync sessionId validation (forward-
  slash / `..` / empty), CQ-098 intermediate-symlink propagation
  from the epoch listing, CQ-094 non-ENOENT failure propagation
  (does NOT mask via fallback), and pageBytes parity with
  `header.pages[*].stored_length`.
- [x] SessionBlobPackV2 bulk inventory listing
  (`listSessionBlobSummaries(bundleRoot)`) returns one
  `SessionBlobSummary` row per session that has a pack in any
  epoch, sorted ascending by `session_id`. Composes
  `listAllSessionBlobSessions` with per-session
  `getSessionBlobSummary`. Result is the deduplicated cross-epoch
  set in summary form — exactly the shape MCP `list_sessions` and
  CLI inventory tables consume. Fresh-bundle / no-packs cases
  resolve to `[]`. Containment + validation inherit from the
  composed helpers (parent CQ-098 throws; per-epoch CQ-094/CQ-098
  collapses to "skip" inside the existence probe; tampered
  latest packs surface a digest mismatch on the per-session
  call). 8 tests cover: fresh-bundle [], all-empty-epoch-dirs
  [], one-row-per-session sorted by id, multi-epoch session
  surfaces once with latest = highest winning the aggregates,
  CQ-099 / non-`.pack` filenames dropped, parent-CQ-098
  propagation, bundle-root-alias acceptance, and no-null-slots
  invariant for the result.
- [x] SessionBlobPackV2 aggregate summary
  (`getSessionBlobSummary({ bundleRoot, sessionId })`) returns a
  single inventory row that combines the full list of epochs that
  have a pack, the latest epoch's identity (path, digest), and
  header-level aggregates (message / turn / tool-call counts,
  ordinal range, page count). Returns `null` when no epoch has a
  pack. Composes `listSessionBlobEpochs` + per-epoch
  `sessionBlobPackExists` + `readSessionBlobHeader` (on the latest
  epoch only). No pages are decompressed; counts come from the
  header. Use case: MCP `list_sessions` row shape, CLI / web
  inventory listings — one call replaces three. 11 tests cover:
  fresh-bundle `null`, all-epochs-without-this-session `null`,
  single-epoch aggregate with header equality, multi-epoch
  enumeration with latest = highest, drop-epochs-without-this-
  session, per-page-counts sum from header (messages/turns/
  tool-calls), sync sessionId rejection (forward-slash / `..` /
  empty), parent-CQ-098 propagation when `derived/session-blob`
  is a symlink, per-epoch CQ-094 skip-and-fallback, bundle-root-
  alias acceptance, and tamper detection on the latest pack.
- [x] SessionBlobPackV2 latest-epoch lookup
  (`latestEpochForSession({ bundleRoot, sessionId })`) returns the
  newest epoch number that has a pack for the session, or `null`
  when no epoch has one. No bytes read; no digest verified.
  Composes `listSessionBlobEpochs` (newest → oldest) with per-epoch
  `sessionBlobPackExists` probes. Sync `sessionId` validation
  (CQ-100 pattern) throws on invalid input before any filesystem
  read; CQ-094/CQ-098 per-epoch failures collapse to "skip and try
  older" via the boolean-return probe; parent CQ-098 rejections
  propagate from the listing helper.
  Use cases: "should I refresh?" flows, cache-key generation
  (epoch is the version stamp), inventory rows showing "newest
  epoch N" without paying for a full header read. 11 tests cover:
  single-pack return, newest-wins across [1, 4, 9], fallback when
  newer epochs lack this session, holes in the sequence, fresh-
  bundle null, all-epochs-without-this-session null, sync
  sessionId rejection (forward-slash / `..` / empty), CQ-094
  final-component skip-and-fallback to older real epoch, parent-
  CQ-098 propagation, bundle-root-alias acceptance, and "does not
  read bytes" invariant verified with a 1-byte garbage file.
- [x] SessionBlobPackV2 cheap existence probe
  (`sessionBlobPackExists({ bundleRoot, sessionId, epoch })`)
  returns `boolean` instead of throwing on negative filesystem
  outcomes — ENOENT, CQ-094 final-component symlink, CQ-098
  intermediate symlink, non-regular-file all resolve to `false`.
  No bytes are read; no digest is verified. Sync input validation
  (CQ-099 grammar / epoch range) still throws to distinguish
  malformed inputs from absent artifacts. Mirrors
  `tantivyIndexDirIsValid`'s probe policy. Use case: CLI/MCP
  pre-flight ("is it worth calling the full loader?"), inventory
  views that count present packs across a many-session pass.
  11 tests cover: present-file returns `true`, fresh-bundle
  `false`, empty-epoch `false`, CQ-094 final-component symlink
  `false`, non-regular-file (directory) `false`, CQ-098 refusal
  at `derived/session-blob` `false`, CQ-098 refusal at
  `epoch-<n>` `false`, bundle-root-alias acceptance,
  synchronous `sessionId` rejection (forward-slash / `..` /
  empty), synchronous `epoch` rejection (negative / non-integer),
  and "does not read bytes" verified with a 1-byte garbage file.
- [x] SessionBlobPackV2 header-only reader
  (`readSessionBlobHeader({ bundleRoot, sessionId, epoch? })`)
  returns just the parsed `SessionBlobPackHeaderV2`
  (`{ epoch, path, pack_digest, header }`) without decompressing any
  page. Pairs with the listing helpers for inventory views that
  render "session X: N messages across K pages, last epoch 5" rows
  without paying decompression cost per row. Epoch resolution:
  explicit epoch → `loadSessionBlobPack`; omitted → newest via
  `loadLatestSessionBlobPack`. All inherited guarantees: pack-digest
  re-verification, CQ-094/CQ-098 containment, CQ-100 sync sessionId
  validation, ENOENT propagation, tamper detection. 10 tests cover:
  explicit-epoch happy path with `pack_digest` re-match, newest-epoch
  fallback when omitted, per-page-counts-sum-correctly invariant
  (50 messages across multiple pages add up to 50 without
  decompression), ENOENT (explicit + omitted), sync sessionId
  validation (both paths), CQ-094 final-component symlink rejection,
  CQ-098 intermediate-symlink rejection via the latest loader,
  tamper detection (byte mutation triggers digest mismatch), and
  pack-digest equality with the writer's emission.
- [x] SessionBlobPackV2 cross-epoch session enumeration
  (`listAllSessionBlobSessions(bundleRoot)`) composes
  `listSessionBlobEpochs` with a per-epoch `listSessionBlobSessions`
  union, returning the deduplicated sorted set of session ids that
  have a pack in any epoch under the bundle. Pairs with
  `loadLatestSessionBlobPack` for "list every session, then
  materialise each one's latest transcript" workflows (CLI
  inventory, MCP `list_sessions`, web dashboards). Containment +
  per-entry symlink + CQ-099 resolver-parity all inherit from the
  composed helpers. 8 tests cover: fresh-bundle [],
  empty-epoch-dirs [], deduplicated union across [1, 3, 7] with
  ids `[alpha, bravo, charlie, delta]`, epoch with only invalid
  filenames contributes nothing, silent drop of symlinked
  `epoch-<n>` entries (security boundary still preserved at
  `loadSessionBlobPack` for explicit reads), parent-level CQ-098
  rejection when `derived/session-blob` is a symlink,
  bundle-root-alias acceptance, and the round-trip-through-resolver
  invariant for the resulting set.
- [x] SessionBlobPackV2 directory listing helpers
  (`listSessionBlobEpochs(bundleRoot)`,
  `listSessionBlobSessions({ bundleRoot, epoch })`) enumerate the
  emitted packs under `<bundleRoot>/derived/session-blob/`. Both
  helpers reuse a shared `detectSessionBlobIntermediateSymlink`
  helper in `src/session-blob/containment.ts` (extracted from the
  previous in-loader copy under the CQ-096 "small shared helper for
  clarity" exception now that the loader and listing both consume
  it). Per-entry rules: regular `epoch-<n>` directories /
  `<session_id>.pack` files are returned sorted ascending,
  deduplicated; symlinked entries are silently dropped; ENOENT
  resolves to an empty list. CQ-099 hardening: every candidate
  session id is validated through `sessionBlobPackPath` so the
  listing surface can never return ids the resolver rejects
  (covers reserved singletons `.`, `..`, and any future grammar
  tightening). 19 tests across both helpers cover: empty/ENOENT
  bundles, sorted+dedup enumeration, name-pattern filtering
  (leading-zero rejection, non-numeric epoch suffix, missing
  pattern, regular file where dir expected for the epoch surface;
  non-`.pack` files and directories for the sessions surface),
  per-entry symlink drop, CQ-098 intermediate-symlink refusal at
  each managed component (`derived`, `derived/session-blob`,
  `epoch-<n>`), bundle-root-alias acceptance under a symlinked
  bundle root, synchronous epoch input validation, CQ-099
  resolver-parity for literal `.pack` and `..pack`, and an
  any-listed-id-round-trips-through-resolver invariant.
- [x] SessionBlobPackV2 production zstd codec wired
  (`zstdSessionBlobCompressor`, `zstdSessionBlobDecompressor`)
  finishes the production round-trip story for the byte-layout
  surfaces. The exports re-use the `@c3-oss/prosa-bundle-v2` zstd
  wrapper so SessionBlob packs share a single canonical
  `windowLog ≤ 23` policy with CAS packs; the native binding stays
  out of the derived-v2 direct dependency surface (only `zstd-napi`,
  already on the workspace `allowBuilds` allowlist, transitively
  links via bundle-v2). Production callers pass them verbatim to
  `writeSessionBlobPack` and `loadTranscriptPage` /
  `iterateTranscript`; the identity codec pair stays a test
  affordance. 5 tests cover: small-session round-trip with
  `header.compression='zstd'` + `verifyPackDigest` re-match,
  redundancy compression sanity (`stored_length` < half
  `uncompressed_length` for an 8 KiB highly redundant block),
  tampered-compressed-page rejection (per-page `stored_hash`
  mismatch surfaces before decompression), cross-page iteration
  across 200 messages on a real zstd pack, and CQ-027-style
  malicious-frame rejection when the embedded `windowLog` exceeds
  the canonical max.
- [x] SessionBlobPackV2 on-disk loader
  (`loadSessionBlobPack({ bundleRoot, sessionId, epoch })`) pairs the
  pack-path resolver with the existing reader: it resolves the
  canonical path (delegating input validation to
  `sessionBlobPackPath`), refuses on symlinks at managed
  intermediate components (`derived`, `derived/session-blob`,
  `derived/session-blob/epoch-<n>` — CQ-098 hardening via private
  `detectSessionBlobIntermediateSymlink`; mirrors the CQ-096
  Tantivy helper in shape and policy), refuses on a symlink at the
  final pack path (CQ-094) or non-regular files, reads the bytes,
  re-verifies `pack_digest` from the bytes alone via
  `verifyPackDigest` (so the header field is never trusted for
  identity), decodes the framed pack exactly once, and returns
  `{ path, bytes, header, pageBytes, pack_digest }` ready to feed
  into `loadTranscriptPage` / `iterateTranscript` without
  re-reading. ENOENT propagates so callers can distinguish a
  missing pack from a corrupt one. Bundle-root containment is NOT
  validated — symlinked bundle-root aliases remain supported.
  11 tests cover: write-then-load round-trip with byte-identity,
  ENOENT propagation, CQ-094 final-component symlink refusal
  (planting an external pack that would otherwise decode),
  non-regular-file refusal (directory at the pack path), tamper
  detection (byte mutation deep in the payload triggers
  digest/length mismatch), input-validation delegation
  (forward-slash, `..`, negative epoch all surface synchronous
  errors before touching the filesystem), `pageBytes` length
  parity with `header.pages[*].stored_length`, CQ-098 refusal at
  `derived/session-blob -> <external>` / `epoch-<n> -> <external>`
  / `derived -> <external>` (each with a valid external pack that
  would otherwise decode), and bundle-root-alias acceptance when
  the managed SessionBlob tree is a real directory under the
  symlinked root.
- [x] SessionBlobPackV2 on-disk path resolver
  (`sessionBlobEpochDir(bundleRoot, epoch)`,
  `sessionBlobPackPath(bundleRoot, sessionId, epoch)`) pins the
  canonical pack layout: one pack per session per epoch at
  `<bundleRoot>/derived/session-blob/epoch-<n>/<session_id>.pack`.
  The epoch dir mirrors bundle-v2's `epochs/<n>/` grouping so
  per-epoch operations (purge, list, rebuild) stay symmetric, and
  the `.pack` suffix matches `cas/packs/*.pack`. Inputs are
  validated to prevent path-traversal injection: `sessionId` must
  match `/^[A-Za-z0-9_\-:.]{1,200}$/`, must not be `.` / `..`, and
  must not contain `..` substrings; `epoch` must be a non-negative
  safe integer. Both functions are pure — no filesystem side
  effects; the runtime writer still owns directory creation, but
  it now reads the pack file location from a single source of
  truth shared with the future `loadSessionBlobPack` reader.
  20 tests cover: canonical-path pinning for both helpers, no-drift
  composition (`sessionBlobPackPath` builds atop `sessionBlobEpochDir`,
  which builds atop `derivedPaths`), relative-root composition,
  qualified external-key form (`prosa.session.v2:provider:key`),
  rejection of forward-slash, backslash, `..` segments (incl. `.`
  and `ses_..escape`), control characters, spaces, empty strings,
  non-strings, 200-char boundary acceptance + 201-char rejection,
  and `epoch` negative / non-integer / NaN / Infinity / non-number
  rejection.
- [x] Tantivy read-side end-to-end integration test
  (`test/integration/tantivy-end-to-end.test.ts`) walks the full
  read-side lifecycle a runtime writer would follow:
  fresh-bundle → plan (full/index_dir_invalid) →
  plant-valid-dir + write-checkpoint → plan (skip) → simulate
  new rows → plan (incremental with lastIndexedRowid +
  currentMaxRowid) → tamper fingerprint → plan
  (full/fingerprint_mismatch) → record prior failure → plan
  (full/prior_run_failed) → clearTantivyIndexDir reset → plan
  (full/index_dir_invalid post-reset) → caller-requested
  overwrite forces full. Also asserts checkpoint writes round-
  trip atomically (CQ-093) and leave no stale temps. 8 test
  cases. Cross-surface parity: the pure `planTantivyRebuild`
  agrees with `planTantivyRebuildFromBundle` for every state;
  `tantivyIndexStatus` mirrors the read surfaces.
- [x] Compaction read-side end-to-end integration test
  (`test/integration/compaction-end-to-end.test.ts`) wires the
  listing + summary + planner + executor-plan composer against
  one realistic multi-epoch Parquet fixture (33 small `sessions`
  segments to trigger `file_count_trigger`, 1 `messages` segment
  to verify no false-fire). Asserts cross-surface invariants:
  every segment the planner merges appears in the listing's
  per-entity set; the summary's per-entity bytes are an upper
  bound on the planner's `totalBytesIn` (planner only merges
  small files); the executor-plan composer emits one COPY
  statement per fired entity in plan order with each statement's
  SQL referencing the input segment paths; and on a fresh bundle
  every surface collapses to empty/zero. 8 test cases.
- [x] SessionBlob read-side end-to-end integration test
  (`test/integration/sessionblob-end-to-end.test.ts`) wires every
  public read surface together against one realistic multi-session
  multi-epoch zstd-encoded fixture (3 sessions × up to 3 epochs).
  Catches drift between layers without re-testing each unit. 12
  test cases exercise: listing surfaces (per-epoch + cross-epoch)
  report the expected epoch + session sets,
  `sessionBlobPackExists` consistent with the listing across every
  (session × epoch) pair,
  `latestEpochForSession` returns the highest emission per session,
  `loadSessionBlobPack` exposes the writer-emitted `pack_digest`
  verbatim for every (session, epoch),
  `loadLatestSessionBlobPack` matches the per-session newest
  emission, `readSessionBlobHeader` (omitted epoch) agrees with
  the latest loader on identity, per-session `getSessionBlobSummary`
  matches the latest header counts (including ordinal range),
  bulk `listSessionBlobSummaries` equals per-session
  `getSessionBlobSummary` row-by-row,
  `loadTranscriptFromBundle` returns canonical-order messages with
  the right body content, streaming
  `iterateTranscriptFromBundle` with range filter matches the
  collect-all form, and `bundleDerivedStatus` aggregates exactly
  what the individual surfaces report.
- [x] Parquet projection segment summary
  (`summariseProjectionSegments(bundleRoot)`) rolls up the flat
  `listProjectionSegments` output into total / per-entity / per-
  epoch byte and count stats:
  `{ total_bytes, total_segments, by_entity, by_epoch }`. Per-entity
  and per-epoch rows use `{ count, bytes }` shape; epoch keys are
  stringified for JSON serializability. Suitable for CLI inventory
  rows and audit reports without callers re-folding the flat list.
  Inherits the listing's filtering (digit-prefixed epoch dirs,
  `compact-<NNNN>` skipped). 7 tests cover: zero-rollup on fresh
  bundle, total bytes/count across multi-epoch fixture, per-entity
  cross-epoch aggregation, per-epoch cross-entity aggregation,
  stringified-epoch keys round-trip through `JSON.parse(JSON.stringify(...))`,
  compact-dir skip inherited by summary, and the
  every-segment-counted-once invariant (entity-counts + epoch-counts
  both equal `total_segments`, entity-bytes + epoch-bytes both
  equal `total_bytes`).
- [x] Parquet projection segment listing
  (`listProjectionSegments(bundleRoot)`) enumerates every
  `epochs/<n>/projection/*.parquet` file as a flat
  `ProjectionSegment[]` (entity type, epoch, relative + absolute
  paths, byte length). Mirrors the compaction planner's filtering
  rules (digit-prefixed epoch dirs only; `compact-<NNNN>` skipped;
  non-`.parquet` files dropped; ENOENT-tolerant) but does not
  apply the compaction-policy decision. Suitable for CLI
  inventory, audit tools, and the future Parquet merge worker
  (currently blocked behind `@duckdb/node-api` allowlist).
  Returns sorted by `(epoch, entityType)` ascending. Includes
  preemptive containment hardening matching the CQ-094/CQ-096
  pattern applied to the `derived/` tree: `<bundleRoot>/epochs`
  as a symlink throws (would redirect the entire walk); per-entry
  rejection silently drops symlinked `epochs/<n>/`, symlinked
  `epochs/<n>/projection/`, and symlinked `.parquet` files from
  the listing; per-file rejection requires regular files for
  segments. Bundle-root containment is deliberately NOT validated
  — the symlinked-bundle-root deployment pattern stays supported.
  15 tests cover the listing semantics (9: fresh-bundle [],
  empty-epoch-dirs [], every `.parquet` across multiple epochs,
  full ProjectionSegment shape, `compact-<NNNN>` skip, non-numeric
  epoch dirs ignored, non-`.parquet` files dropped, multi-epoch
  sorted ordering, single-epoch many-segments order) and the
  containment hardening (6: symlinked `epochs/` throws,
  symlinked `epochs/<n>/` silently dropped, symlinked
  `epochs/<n>/projection/` silently dropped, symlinked `.parquet`
  silently dropped, bundle-root-alias accepted, summary inherits
  the parent-throw via the composed listing).
- [x] Cross-subsystem epoch touched-set
  (`derivedLayerEpochsTouched(bundleRoot)`) returns the sorted
  deduplicated union of epochs that actually have a SessionBlob
  `.pack` file or a Parquet projection segment on disk. Pairs with
  audit/GC planning ("which epochs have any derived artifact?").
  CQ-104 fix: the SessionBlob side filters
  `listSessionBlobEpochs` candidates through
  `listSessionBlobSessions(epoch)` so empty `epoch-<n>/`
  directories — created by the writer but not yet populated with a
  pack — do not over-report the keep-set; only epochs with at
  least one real pack contribute. Inherits both surfaces'
  containment (CQ-098 parent + CQ-098 per-epoch +
  epochs/-symlink throws propagate). 8 tests cover: fresh-bundle
  [], SessionBlob-only, projection-only, deduplicated union
  across both subsystems with overlap, CQ-098 propagation from
  SessionBlob listing, epochs/-symlink rejection from projection
  listing, CQ-104 empty-SessionBlob-epoch-dir exclusion, and
  CQ-104 empty-SessionBlob-epoch-dir + projection-overlap
  (projection-only epoch still surfaces even when an empty
  SessionBlob dir exists for the same epoch).
- [x] `prosa index-v2` CLI group (`apps/cli/src/cli/commands/index-v2.ts`)
  shipping eleven pure-read subcommands. `status` wires
  `bundleDerivedStatus(--store)`; `sessions` wires
  `listSessionBlobSummaries(--store)`; `epochs` wires
  `derivedLayerEpochsTouched(--store)`; `analytics-views` wires
  `analyticsViewsDescriptor()` (content-free, takes no `--store`);
  `analytics-execution-plan` wires `planAnalyticsExecution({
  bundleRoot: --store, view: --view, reportQuery: --report-query
  })`; `projection-segments` wires
  `listProjectionSegments(--store)` by default and
  `summariseProjectionSegments(--store)` with `--summary`;
  `tantivy-rebuild-plan` wires `planTantivyRebuildFromBundle({
  bundleRoot: --store, currentMaxRowid: --current-max-rowid,
  overwriteRequested: --overwrite })`; `compaction-plan` wires
  `planCompaction(--store)`; `compaction-execution-plan`
  composes `planCompaction(--store)` then
  `planCompactionExecution({ bundleRoot, plan })`;
  `transcript-header` wires `readSessionBlobHeader({ bundleRoot:
  --store, sessionId: --session-id, epoch: --epoch })` for a
  header-only probe (no page decompression); `transcript`
  wires `loadTranscriptFromBundle({ bundleRoot: --store,
  sessionId: --session-id })`. All eleven print pretty JSON to
  stdout — no native bindings, no filesystem mutation. The
  `index-v2` parent command is the eventual home for `tantivy`
  (blocked on the native binding); `status`, `sessions`,
  `epochs`, `analytics-views`, `analytics-execution-plan`,
  `projection-segments`, `tantivy-rebuild-plan`,
  `compaction-plan`, `compaction-execution-plan`,
  `transcript-header`, and `transcript` ship now and stand in for
  the JSON-form path of gate criterion 3 (`prosa session show
  <id>` against a v2 bundle — v1-renderer parity output is a
  follow-up). `compaction-plan` also gives the scripted-scenario
  inspection surface for gate criterion 5 (compaction trigger
  validation) without needing the runtime executor.
  `analytics-views` ships the canonical view-shape contract to
  MCP / web / scripted consumers ahead of the DuckDB runtime
  executor landing. `projection-segments` (flat + `--summary`
  rollup) is the per-segment counterpart to `epochs` /
  `compaction-plan` and pairs with audit reports that want the
  raw layout, not just the trigger decision.
  `tantivy-rebuild-plan` exposes the Tantivy rebuild state
  machine outcome (`skip` / `incremental` / `full` + reason +
  fingerprint) the runtime writer would apply for a
  caller-supplied `--current-max-rowid`, so the rebuild decision
  can be inspected without the native binding.
  `analytics-execution-plan` composes the entity preamble + view
  body + report query DuckDB statement sequence the runtime
  executor would issue — the auditable counterpart to
  `analytics-views` that pins the bundle root in the preamble.
  `compaction-execution-plan` composes `planCompaction` +
  `planCompactionExecution` so the auditor sees the exact
  `COPY (SELECT ... FROM read_parquet([...])) TO ...` statements
  the runtime worker would issue per entity.
  `transcript` accepts `--format json` (default) or `--format text`
  for a plain-text rendering of the v2 transcript via
  `formatTranscriptTextV2`, with a metadata header (epoch /
  pack_digest / path / message_count) preceding the messages.
  CQ-105: the format flag is validated synchronously before any
  bundle read so an invalid format surfaces `invalid --format`
  rather than a misleading missing-session error.
  `transcript-header` exposes the SessionBlob header (per-page
  message/turn/tool-call counts, ordinal ranges, stored +
  uncompressed page lengths) without decompressing any page —
  cheap probe surface for dashboards that want pack-level
  aggregates only.
  49 subprocess tests (`apps/cli/test/cli/index-v2.test.ts`) cover:
  parent `--help` listing all eleven subcommands, `status`
  `--help` + fresh-bundle empty snapshot + SessionBlob-populated
  snapshot + missing-`--store` (4); `sessions --help` +
  fresh-bundle `[]` + multi-session multi-epoch inventory (alpha
  across epochs [1,3] + bravo at [1]) with `latest_epoch`
  correctness + missing-`--store` (4); `epochs --help` +
  fresh-bundle `[]` + sorted deduplicated union (SessionBlob
  packs at [1,4] + projection segments at [2,4] → `[1,2,4]`) +
  missing-`--store` (4); `analytics-views --help` documenting
  the catalog + no `--store <path>` option line + the five
  canonical view descriptors (`session_facts`,
  `tool_usage_facts`, `error_facts`, `model_usage`,
  `project_activity`) each with non-empty columns and a SQL
  body containing `CREATE OR REPLACE VIEW` and the view name (2);
  `projection-segments --help` documenting `--store` and
  `--summary` + fresh-bundle `[]` + flat listing (planted
  `sessions.parquet` at epoch 1 + `messages.parquet` at epoch 2
  surfaces as the expected two `ProjectionSegment` rows in
  `(epoch, entityType)` sort order) + `--summary` rollup
  (3-segment / 700-byte total split across `by_entity` and
  `by_epoch`) + missing-`--store` (5);
  `analytics-execution-plan --help` documenting `--store` +
  `--view` + `--report-query` + `--view session_facts` against
  a fresh bundle returning the entity preamble (every setup
  statement is semicolon-terminated, the last is the
  `CREATE OR REPLACE VIEW session_facts ...` body, the entity
  preamble contains the bundle root path via `parquetReadFor`)
  + default `reportQuery: 'SELECT * FROM session_facts;'` +
  `--report-query` override pass-through + unknown-`--view`
  rejected synchronously + missing-`--view` failure (5);
  `tantivy-rebuild-plan --help` documenting `--store` +
  `--current-max-rowid` + `--overwrite` + fresh-bundle returns
  `{ plan: { kind: 'full', reason: 'index_dir_invalid',
  currentMaxRowid: 0 }, indexDirValid: false, checkpoint:
  { last_indexed_rowid: null, status: null } }` +
  `--overwrite` forces `kind: 'full', reason:
  'caller_requested_overwrite'` with the supplied
  `currentMaxRowid` echoed + negative `--current-max-rowid`
  rejected with synchronous validation error + missing-
  `--current-max-rowid` failure (5);
  `compaction-plan --help` + fresh-bundle empty plan +
  17-small-segments `low_count_byte_ceiling` trigger firing for
  the `sessions` entity (asserting `entities[0].reason`,
  `segmentsToMerge.length === 17`, `totalBytesIn === 17 *
  1024`, and a non-empty `outputPath`) + missing-`--store` (4);
  `compaction-execution-plan --help` documenting `--store` +
  fresh-bundle empty execution (`plan.empty=true` and
  `statements=[]`) + 17-small-segments trigger emitting a single
  `COPY (SELECT * FROM read_parquet([...], union_by_name =>
  true)) TO '<outputAbsPath>' (FORMAT 'parquet', CODEC 'zstd');`
  statement that references every one of the 17 source paths
  inside the array + missing-`--store` failure (4);
  `transcript-header --help` documenting `--store` +
  `--session-id` + `--epoch` + latest-epoch header round-trip
  (`pack_digest` echoed from the header, `header.page_count > 0`,
  `header.pages.length === header.page_count`) +
  specific-`--epoch` selection (epochs 1 and 4 planted; default
  returns epoch 4, `--epoch 1` returns epoch 1) +
  negative-`--epoch` rejected synchronously (4);
  `transcript --help` documenting `--store` + `--session-id` +
  `--format` + real zstd-compressed pack round-trip with
  epoch/pack_digest/messages fields + unknown-session failure +
  missing-`--session-id` failure + `--format text` rendered with
  the metadata header + `[#0] role @ ts (turn: id)` line +
  `  blk_id | type | inline (N bytes)` line + indented body +
  `--format json` explicit + CQ-105 `--format yaml` rejected
  BEFORE any bundle read (stderr matches `invalid --format` and
  does not mention `loadLatestSessionBlobPack`) (7). Apps/cli typecheck +
  lint clean; pulled in `@c3-oss/prosa-derived-v2` as a
  workspace dependency.
- [x] Bundle-level derived-layer status aggregator
  (`bundleDerivedStatus(bundleRoot)`) composes `tantivyIndexStatus`
  + `listSessionBlobSummaries` + `listSessionBlobEpochs` into one
  read-only snapshot: `{ tantivy, session_summaries, session_count,
  session_blob_epochs }`. Suitable for `prosa bundle status` CLI /
  MCP `read_bundle_status` tool / web bundle-overview panels.
  Composed reads run concurrently via `Promise.all` so the
  aggregate latency is the slowest single-subsystem read. Each
  composed surface enforces its own containment + validation; a
  failure in any subsystem propagates unchanged. 8 tests cover:
  fresh-bundle empty snapshot, SessionBlob-only (no Tantivy),
  Tantivy-only (no SessionBlob), combined-populated snapshot,
  session_count = summaries.length invariant, CQ-098 propagation
  from SessionBlob aggregation, bundle-root-alias acceptance, and
  current-fingerprint exposure.
- [x] Analytics views catalog descriptor
  (`analyticsViewsDescriptor()`, `analyticsViewDescriptor(name)`)
  packages the existing `ANALYTICS_VIEW_NAMES` +
  `ANALYTICS_VIEW_COLUMNS` + `analyticsViewSql()` exports into one
  queryable shape — array of `{ name, columns, sql }` records, one
  per view, in canonical `ANALYTICS_VIEW_NAMES` order. Suitable
  for MCP `list_analytics_views`, CLI `prosa analytics views`,
  and web "available analytics" panels. The per-view descriptor
  throws on unknown names so misspellings surface immediately
  rather than producing a descriptor with `undefined` fields. Pure
  read path — no filesystem, no DuckDB; ships independent of the
  `@duckdb/node-api` allowlist. 8 tests cover: per-view descriptor
  has name/columns/sql matching canonical exports, unknown-name
  rejection, fresh-object-per-call (no shared mutable state), bulk
  result one-per-view in canonical order, every descriptor has
  populated columns/sql, length equals `ANALYTICS_VIEW_NAMES.length`,
  fresh-array-per-call with fresh per-element objects, and
  columns-is-canonical-reference invariant.
- [x] Tantivy index status reader
  (`tantivyIndexStatus(bundleRoot)`) aggregates the existing
  `readIndexCheckpoint` + `tantivyIndexDirIsValid` +
  `currentTantivySchemaFingerprint` into one CLI/MCP-friendly
  status snapshot:
  `{ checkpoint_present, index_dir_valid, checkpoint,
  current_schema_fingerprint, schema_fingerprint_match,
  ready_for_read }`. `ready_for_read` is `true` only when every
  gate passes (checkpoint present, status='ready', no
  error_message, index dir valid per CQ-094/CQ-096 probe,
  fingerprint matches the pinned schema). Pure read path — no
  filesystem writes, no native binding. Suitable for
  `prosa index-v2 status` CLI and MCP `read_index_status` without
  requiring `@oxdev03/node-tantivy-binding` allowlist expansion.
  10 tests cover: fresh-bundle all-false snapshot, index-dir
  valid without checkpoint, checkpoint-present surfaces snapshot,
  stale-fingerprint detection (`schema_fingerprint_match: false`,
  `ready_for_read: false`), fully-ready gate (all five pass),
  `ready_for_read: false` when status='building',
  `ready_for_read: false` when status='failed' with error
  message, `ready_for_read: false` when index dir is missing even
  with a ready checkpoint, current-fingerprint-shape invariant
  (`/^blake3:[0-9a-f]{64}$/`), and propagation of malformed-
  checkpoint corruption errors (does not silently mask).
- [x] Tantivy index-dir reset helper (`clearTantivyIndexDir(bundleRoot)`)
  for the `full`-rebuild path. The planner returns `kind: 'full'` when
  the prior index is unrecoverable; before the native writer opens a
  clean slate the caller must wipe `<bundleRoot>/derived/tantivy/index`.
  The reset is filesystem-aware: it `lstat`s the index path, refuses
  to traverse a symlink there (CQ-094 hardening — recursive removal
  through a symlink could delete an arbitrary external directory),
  refuses to operate on a regular file planted at the index path, and
  is idempotent on a fresh bundle (no-op + `mkdir`). On a populated
  directory it recursively removes contents (`fs.rm` with
  `recursive: true` does not follow symlinks — symlinked children
  unlink in place) and recreates the empty directory so the writer can
  open it immediately. CQ-096 extends the symlink-rejection contract
  to intermediate components (`<bundleRoot>/derived`,
  `<bundleRoot>/derived/tantivy`): the helper rejects before the
  fresh-reset `mkdir` could resolve through a symlinked intermediate
  and create `<external>/index` outside the bundle. Bundle-root
  containment is **not** validated — opening a bundle through a
  symlinked alias remains a supported deployment pattern. 10 tests
  cover: fresh-bundle idempotency, repeated-invocation idempotency,
  recursive removal of stale segments + meta, CQ-094 refusal on
  symlinked index dir (external target unchanged, symlink left in
  place for operator), CQ-096 refusal when `derived/tantivy` is a
  symlink with no `index` yet (external dir not mutated), CQ-096
  refusal when `derived` is a symlink (external sentinel preserved),
  CQ-096 success when bundle root opened via a symlinked alias and
  derived tree is real, refusal on regular file at index path,
  symlinked-children unlink semantics (target survives), and
  sibling-surface preservation (`derived/analytics` intact after
  reset).
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
pnpm --filter @c3-oss/prosa-derived-v2 test         # 409 tests / 35 files (+9 formatTranscriptTextV2)
pnpm --filter @c3-oss/prosa exec vitest run test/cli/index-v2.test.ts  # 49 subprocess-spawned tests for index-v2 status + sessions + epochs + analytics-views + analytics-execution-plan + projection-segments + tantivy-rebuild-plan + compaction-plan + compaction-execution-plan + transcript-header + transcript (incl. CQ-105 --format pre-read validation) (writer-policy 11, compaction 6, framing 8, writer/reader 11, compaction planner 13 incl. CQ-101 + CQ-102 containment regressions, compaction executor-plan 8, analytics views 11, tantivy schema 7, tantivy rebuild-plan 10, projection-bridge 9, reader-iterator 7, tantivy checkpoint-store 21 (11 prior + 4 write CQ-096 + 6 read CQ-103), analytics executor-plan 9, tantivy index-dir probe 17, tantivy plan-bundle orchestration 9, tantivy status 10, analytics descriptor 8, bundle status 16 (8 prior aggregator + 8 derivedLayerEpochsTouched incl. CQ-104 empty-epoch-dir regressions), compaction segments 22 (9 listing + 7 summary + 6 containment), derived-layout 27, tantivy clear-index-dir 10, session-blob loader 11, session-blob zstd 5, session-blob listing 27 (19 prior + 8 listAllSessionBlobSessions cross-epoch union), session-blob latest 11 incl. CQ-100, session-blob transcript-from-bundle 8, session-blob iterate-from-bundle 9, session-blob header 10, session-blob exists 11, session-blob latest-epoch 11, session-blob summary 19 (11 single + 8 bulk listing), integration sessionblob-end-to-end 12, integration compaction-end-to-end 8, integration tantivy-end-to-end 8)
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
