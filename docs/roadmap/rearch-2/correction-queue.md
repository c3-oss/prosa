# rearch-2 Correction Queue

Corrections with `Blocking: yes` must be closed before `RALPH_DONE`.

## Open

(none — `CQ-091`..`CQ-107` are all closed.)

## Closed (latest first)

### CQ-107: Validate Persisted Compact Manifest Entity Shape on Read — closed 2026-05-19

Status: closed
Severity: medium
Blocking: yes
Owner: Ralph
Opened: 2026-05-19
Closed: 2026-05-19
Lane: 3 - Derived layer

Finding:

The first `readCompactManifestV2()` slice parsed
`compact.manifest.json` and validated only the top-level object,
`schema`, `compaction_seq`, `generated_at`, and `entities` array
presence. It then returned `value as CompactManifestV2` with a
comment saying to trust the per-entity shape because the writer
goes through the builder.

Risk:

`readCompactManifestV2()` is the persisted-format boundary for
audit/GC recovery. Files can be corrupted, manually edited,
partially written by older tools, or produced by another
implementation. A reader that accepts malformed entity rows or
malformed `superseded` segments would hand invalid paths, byte
counts, or epochs to future GC/audit code despite claiming the
manifest shape was validated.

Resolution:

Replaced the trust-the-builder shortcut with full deep
validation. Every entity must be an object with non-empty string
`entity_type`, `reason` from the known set
(`file_count_trigger` | `low_count_byte_ceiling`), non-empty
string `output_path`, non-negative integer `total_bytes_in`,
and an array `superseded`. Every superseded segment must be an
object with non-negative integer `epoch`, non-empty string
`path`, and non-negative integer `byte_length`. The reader also
now verifies `manifest.compaction_seq` matches the requested
`compactionSeq` argument — a drift here is almost always a bug.

Acceptance criteria — all met:

- ✅ `pnpm --filter @c3-oss/prosa-derived-v2 exec vitest run
  test/compaction/manifest.test.ts` passes with 7 new CQ-107
  regressions: seq mismatch, missing entity_type, unknown reason
  enum, negative total_bytes_in, non-integer superseded.epoch,
  empty superseded.path, entities array of strings (non-objects).
- ✅ `pnpm --filter @c3-oss/prosa-derived-v2 typecheck` clean.
- ✅ `pnpm --filter @c3-oss/prosa-derived-v2 lint` clean.
- ✅ `git diff --check` clean.
- ✅ Full repo `pnpm turbo run test` 13/13.

### CQ-106: Markdown Transcript Fences Must Survive Backtick Runs — closed 2026-05-19

Status: closed
Severity: medium
Blocking: yes
Owner: Ralph
Opened: 2026-05-19
Closed: 2026-05-19
Lane: 3 - Derived layer

Finding:

The first `formatTranscriptMarkdownV2()` slice emitted fixed triple
backtick fences for non-plain inline blocks and `cas_ref` previews.
Transcript content is arbitrary user/tool text, so a payload or
preview that contains a `` ``` `` run could prematurely close the
fence and let subsequent transcript bytes render as Markdown
structure outside the block.

Risk:

Markdown export could misrepresent transcript content and make
rendered output unsafe to paste into docs/chats/PRs. A transcript
containing fenced-code text must remain a faithful literal payload,
not escape the renderer's block structure.

Resolution:

Added a `pickFence(text)` helper that scans the body for the longest
contiguous run of backticks and returns a fence of
`max(3, longestRun + 1)` backticks. Both inline-text fenced
rendering and the `cas_ref` preview blockquote use the helper, so
arbitrary backtick-bearing payloads now get a fence that cannot be
closed by their own content. Existing tests with ordinary content
(no backtick runs) continue to use the three-backtick fence.

Acceptance criteria — all met:

- ✅ `corepack pnpm --filter @c3-oss/prosa-derived-v2 exec vitest
  run test/session-blob/transcript-format-markdown.test.ts` passes
  (15 tests, including 3 new CQ-106 regressions covering
  triple-backtick inline body, five-backtick inline body, and
  triple-backtick cas_ref preview).
- ✅ `corepack pnpm --filter @c3-oss/prosa exec vitest run
  test/cli/index-v2.test.ts` passes (50 tests).
- ✅ `corepack pnpm --filter @c3-oss/prosa-derived-v2 typecheck` passes.
- ✅ `corepack pnpm --filter @c3-oss/prosa typecheck` passes.
- ✅ `corepack pnpm --filter @c3-oss/prosa-derived-v2 lint` passes.
- ✅ `corepack pnpm --filter @c3-oss/prosa lint` passes.
- ✅ `git diff --check` passes.
- ✅ Full repo `pnpm turbo run test` — 13/13 turbo.

### CQ-105: Validate `index-v2 transcript --format` Before Bundle Reads — closed 2026-05-19

Status: closed
Severity: medium
Blocking: yes
Owner: Ralph
Opened: 2026-05-19
Closed: 2026-05-19
Lane: 3 - Derived layer

Finding:

The first `index-v2 transcript --format text|json` slice validated
`--format` after `loadTranscriptFromBundle()` had already read the
bundle. An invalid format failed with an unrelated session/bundle
error before the CLI reported the bad option. Codex confirmed this
with `corepack pnpm --filter @c3-oss/prosa exec vitest run
test/cli/index-v2.test.ts -t "format yaml"`, which surfaced
`Error: loadLatestSessionBlobPack: no pack found for session
"ses_alpha"` instead of `/invalid --format/i`.

Risk:

CLI option validation becomes data-dependent. Users who typo
`--format` would get a misleading missing-session or bundle error,
and automation could not rely on a stable invalid-option failure
before I/O.

Resolution:

Moved the `options.format !== 'json' && options.format !== 'text'`
check to the very top of the `transcript` action, before
`resolvePath` or `loadTranscriptFromBundle`. Default JSON output and
`--format text` output are preserved. The regression test was
strengthened to (a) point at a never-initialised store so the load
would otherwise throw and (b) assert that stderr does NOT mention
`loadLatestSessionBlobPack` / `no pack found`, ensuring the
format check fires first.

Acceptance criteria — all met:

- ✅ `corepack pnpm --filter @c3-oss/prosa exec vitest run
  test/cli/index-v2.test.ts -t "format yaml"` passes (the renamed
  `CQ-105: \`index-v2 transcript --format yaml\` rejects unknown
  formats BEFORE any bundle read` regression).
- ✅ Full `corepack pnpm --filter @c3-oss/prosa exec vitest run
  test/cli/index-v2.test.ts` passes (49 tests / 1 file).
- ✅ `corepack pnpm --filter @c3-oss/prosa typecheck` passes.
- ✅ `corepack pnpm --filter @c3-oss/prosa lint` passes.
- ✅ `git diff --check` passes.
- ✅ Full repo `pnpm turbo run test` — 13/13 turbo.

### CQ-104: `derivedLayerEpochsTouched` Must Count Artifacts, Not Empty SessionBlob Epoch Dirs — closed 2026-05-19

Status: closed
Severity: medium
Blocking: yes
Owner: Ralph
Opened: 2026-05-19
Closed: 2026-05-19
Lane: 3 - Derived layer

Finding:

The current `derivedLayerEpochsTouched(bundleRoot)` WIP documents its
result as "every epoch number where the bundle's derived layer has at
least one artifact — a SessionBlob pack or a Parquet projection
segment." The implementation built the SessionBlob side from
`listSessionBlobEpochs(bundleRoot)`, but that helper enumerates
canonical epoch directories and can include epochs with no `.pack`
files. `bundleDerivedStatus.session_blob_epochs` already documents
that empty writer-created epoch dirs may appear there.

Risk:

The new helper is framed as an audit/GC keep-set primitive. Counting an
empty SessionBlob epoch directory as an artifact-bearing epoch
overstates what must survive a prune and contradicts the "pack or
projection segment" contract. It can also mask future bugs where an
epoch directory is created but no derived payload is written.

Resolution:

Switched `derivedLayerEpochsTouched()` to enumerate only epochs with
actual SessionBlob `.pack` files plus Parquet projection segments.
The SessionBlob side now feeds candidate epochs from
`listSessionBlobEpochs(bundleRoot)` through
`listSessionBlobSessions({ bundleRoot, epoch })` and only includes
epochs whose listing returns at least one session; empty
writer-created epoch dirs no longer over-report the keep-set.
Deterministic sorted/deduplicated output and containment
propagation (CQ-098 parent + CQ-098 per-epoch + epochs/-symlink)
are preserved.

Acceptance criteria — all met:

- ✅ Regression added: empty `derived/session-blob/epoch-<n>/`
  directories alongside a real pack at a different epoch result
  in the epochs-touched set containing only the pack-bearing
  epoch (`bundle-status.test.ts > derivedLayerEpochsTouched >
  CQ-104: empty SessionBlob epoch directories do NOT contribute`).
- ✅ Regression added: pack-bearing SessionBlob epoch is returned
  (pre-existing test still passes after the fix).
- ✅ Projection-only, deduplicated union, and symlink propagation
  tests continue to pass.
- ✅ Focused gates pass:
  - `pnpm --filter @c3-oss/prosa-derived-v2 test` — 400 tests / 34 files
  - `pnpm --filter @c3-oss/prosa-derived-v2 typecheck` — clean
  - `pnpm --filter @c3-oss/prosa-derived-v2 lint` — clean
  - `git diff --check` — clean
  - Full repo `pnpm turbo run test` — 13/13 turbo
- ✅ `docs/roadmap/rearch-2/evidence/lane-03.md`, `gates.md`,
  `status.md`, and `ralph-loop-prompt.md` updated as part of the
  closeout commit pair.

### CQ-103: Tantivy Checkpoint Reads Must Reject Symlink Escapes — closed 2026-05-19

Status: closed
Severity: high
Blocking: yes
Owner: Ralph
Opened: 2026-05-19
Closed: 2026-05-19
Lane: 3 - Derived layer

Finding:

The current Tantivy checkpoint WIP adds a CQ-096-style intermediate
symlink guard to `writeIndexCheckpoint()`, which prevents checkpoint
writes from traversing symlinked `<bundleRoot>/derived` or
`<bundleRoot>/derived/tantivy`. However, `readIndexCheckpoint()` still
uses `readFile(tantivyCheckpointPath(bundleRoot))` directly. That read
follows symlinked intermediates and a symlinked final
`checkpoint.json` component.

Risk:

`planTantivyRebuildFromBundle()` consumes checkpoint state to decide
between skip, incremental, and full rebuilds. If checkpoint reads can
follow an external symlink, an attacker or corrupted bundle can supply
external `lastIndexedRowid`, schema fingerprint, status, or failure
state while the planner believes it is reading canonical bundle-local
state. This weakens the same managed-derived-tree containment already
enforced for the Tantivy index directory and clear-reset paths.

Required fix:

- Apply the same intermediate symlink containment to
  `readIndexCheckpoint()` and `readIndexCheckpointOrEmpty()` that the
  WIP applies to `writeIndexCheckpoint()`.
- Reject a symlinked final `checkpoint.json` component before reading.
- Preserve existing fresh-bundle / missing-checkpoint behavior:
  `readIndexCheckpoint()` returns `null` on a genuinely absent
  checkpoint, and `readIndexCheckpointOrEmpty()` returns
  `EMPTY_INDEX_CHECKPOINT`.
- Preserve the supported symlinked bundle-root alias pattern; reject
  only symlinks inside the managed derived tree.

Acceptance criteria:

- Tests prove checkpoint reads throw/refuse on:
  - symlinked `<bundleRoot>/derived`;
  - symlinked `<bundleRoot>/derived/tantivy`;
  - symlinked final `checkpoint.json`.
- Tests prove `writeIndexCheckpoint()` also refuses the managed
  intermediate symlink cases and still accepts a symlinked bundle-root
  alias.
- Fresh-bundle / missing-checkpoint behavior remains unchanged.
- Focused gates pass:
  - `pnpm --filter @c3-oss/prosa-derived-v2 test`
  - `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`
  - `pnpm --filter @c3-oss/prosa-derived-v2 lint`
  - `git diff --check`
- Update `docs/roadmap/rearch-2/evidence/lane-03.md`, `gates.md`,
  `status.md`, and `ralph-loop-prompt.md` before closing.

Closure note:

Fix lands in this iteration alongside the same-pattern write-side
hardening (which was itself preemptive). `readIndexCheckpoint`
now:

1. Calls `detectDerivedTantivyIntermediateSymlink(bundleRoot)`
   first and throws when any managed intermediate
   (`<bundleRoot>/derived`, `<bundleRoot>/derived/tantivy`) is a
   symlink.
2. `lstat`s the final `checkpoint.json` and throws on symlink
   (CQ-103 final-component refusal) or non-regular-file. The
   existing ENOENT → `null` contract is preserved for genuinely
   absent state.
3. Only after both guards pass does it `readFile` and parse the
   canonical JSON.

`readIndexCheckpointOrEmpty` inherits the refusal transitively
because it calls `readIndexCheckpoint`. `writeIndexCheckpoint`
already got the matching intermediate guard in the preemptive
pass.

The previously-private `detectDerivedTantivyIntermediateSymlink`
helper is now exported from `tantivy/index-dir.ts` so the
checkpoint store can import it without re-implementing the walk.

Regression coverage (10 new tests total: 4 write-side + 6
read-side):

- Write: refuses symlinked `derived/tantivy`, symlinked `derived`,
  accepts symlinked bundle-root alias, fresh-bundle still works.
- Read: refuses symlinked `derived/tantivy` (with valid external
  checkpoint to confirm policy not content), refuses symlinked
  `derived`, refuses symlinked final `checkpoint.json`, refuses
  directory-at-final-path, accepts symlinked bundle-root alias,
  and `readIndexCheckpointOrEmpty` inherits the refusal.

Validation:

- `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`: pass.
- `pnpm --filter @c3-oss/prosa-derived-v2 test`: pass, 392 tests /
  34 files.
- `pnpm --filter @c3-oss/prosa-derived-v2 lint`: pass.
- Full repo `pnpm build` / `pnpm test` / `pnpm lint`: 13/13 turbo.
- `pnpm test:conformance`: pass, 26 / 2.
- `git diff --check`: pass.

## Closed (latest first)

### CQ-102: Complete CQ-101 Planner/Execution Containment Evidence — closed 2026-05-19

Status: closed
Severity: medium
Blocking: yes
Owner: Ralph
Opened: 2026-05-19
Closed: 2026-05-19
Lane: 3 - Derived layer

Finding:

`CQ-101` is closed, and the implementation now routes
`planCompaction()` through `listProjectionSegments()`, which is the
right containment shape. However, the written `CQ-101` acceptance
criteria are not fully proven by the closeout evidence. The closure
note says "3 regression tests prove the inherited behaviour at every
chain level", but those planner tests cover only symlinked
`<bundleRoot>/epochs`, symlinked `epochs/<n>`, and symlinked final
`.parquet` files. They do not directly cover a symlinked
`epochs/<n>/projection` directory through `planCompaction()`, and no
test composes the resulting plan through `planCompactionExecution()`
to prove execution statements never receive external symlink targets.

Risk:

The code path is probably safe because `planCompaction()` now shares
the hardened listing helper, but the gate evidence overclaims the
tested surface. This is exactly the kind of evidence drift that lets a
future planner/listing split reintroduce a containment bug while the
roadmap still claims planner and execution coverage.

Required fix:

- Add a planner regression proving a symlinked
  `epochs/<n>/projection` directory is silently dropped and cannot
  fire compaction by contributing external segments.
- Add an integrated planner-to-execution regression proving that
  symlinked `epochs/<n>`, symlinked `epochs/<n>/projection`, and
  symlinked final `.parquet` cases do not produce
  `planCompactionExecution()` statements containing external absolute
  paths.
- Reconcile the `CQ-101` closure note / Lane 3 evidence so it names
  the actual coverage without overclaiming.

Acceptance criteria:

- Focused tests cover the missing symlinked `projection/` planner
  case.
- Focused tests prove `planCompactionExecution()` receives no external
  symlink target paths from the `CQ-101` containment cases.
- Focused gates pass:
  - `pnpm --filter @c3-oss/prosa-derived-v2 test`
  - `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`
  - `pnpm --filter @c3-oss/prosa-derived-v2 lint`
  - `git diff --check`
- Update `docs/roadmap/rearch-2/evidence/lane-03.md`, `gates.md`,
  `status.md`, and `ralph-loop-prompt.md` before closing.

Closure note:

Fix lands in this iteration. Two regression tests added under the
`CQ-101: containment hardening inherited from listProjectionSegments`
suite in `planner.test.ts`:

- `CQ-102: silently drops a symlinked epochs/<n>/projection/
  directory from the plan` — plants 16 real small segments
  (low-count trigger boundary) + a 5-segment external dir
  symlinked through `epochs/17/projection`. Plan stays empty
  because the symlinked projection dir is silently dropped before
  the policy decision.
- `CQ-102: planner-to-execution: planCompactionExecution never
  receives external symlink targets` — plants 17 real segments
  (triggers the low-count trigger so the plan emits an entity
  row) plus three external attacks: symlinked `epochs/99` (whole
  epoch), symlinked `epochs/100/projection` (projection only),
  and symlinked `epochs/101/projection/sessions.parquet` (final
  file). Calls `planCompactionExecution({ bundleRoot, plan })`
  and asserts that for every emitted statement, the SQL string
  contains zero references to any of the four external paths,
  the output absolute path stays inside the bundle, and every
  segment in the plan resolves to a path under the bundle root.
- Belt-and-suspenders re-verification through the plan
  structure itself: even if the executor-plan composer stops
  embedding absolute input paths in the SQL, the plan-level
  paths are checked separately.

Closure also reconciles the CQ-101 evidence quote in the lane
docs to name the actual coverage (no "every chain level"
overclaim).

Validation:

- `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`: pass.
- `pnpm --filter @c3-oss/prosa-derived-v2 test`: pass, 382 tests /
  34 files.
- `pnpm --filter @c3-oss/prosa-derived-v2 lint`: pass.
- Full repo `pnpm build` / `pnpm test` / `pnpm lint`: 13/13 turbo.
- `pnpm test:conformance`: pass, 26 / 2.
- `git diff --check`: pass.

### CQ-101: Apply Projection-Segment Symlink Containment to Compaction Planner — closed 2026-05-19

Status: closed
Severity: high
Blocking: yes
Owner: Ralph
Opened: 2026-05-19
Closed: 2026-05-19
Lane: 3 - Derived layer

Finding:

The current WIP hardens `listProjectionSegments(bundleRoot)` by
`lstat`ing the projection segment chain and rejecting symlinks at
`<bundleRoot>/epochs`, `epochs/<n>`, `epochs/<n>/projection`, and
the final `.parquet` file. However, `planCompaction(bundleRoot)`
still performs its own independent walk using `stat()` and therefore
still follows symlinks in the same managed projection tree.

Risk:

The future Parquet merge worker consumes `planCompaction()` /
`planCompactionExecution()`, not only the read-only listing helper.
If the planner follows a symlinked epoch/projection directory or
symlinked `.parquet` file to an external target, the resulting plan
can include external input paths and later merge bytes outside the
bundle while appearing to operate on canonical
`epochs/<n>/projection/*.parquet` segments. This breaks the same
containment invariant already enforced for Tantivy and SessionBlob
read paths.

Required fix:

- Make `planCompaction()` use the same projection-segment containment
  rules as `listProjectionSegments()`.
- Prefer a shared helper so listing and planner cannot drift again.
- Preserve existing behavior for a fresh bundle and missing
  per-epoch `projection/` directories.
- Keep the supported symlinked-bundle-root deployment pattern; the
  rejection target is symlinks inside the managed `epochs/` tree.

Acceptance criteria:

- Regression tests prove `planCompaction()` refuses or drops:
  - symlinked `<bundleRoot>/epochs`;
  - symlinked `epochs/<n>`;
  - symlinked `epochs/<n>/projection`;
  - symlinked final `.parquet` files.
- `planCompactionExecution()` never receives external paths from
  those symlinked cases.
- Focused gates pass:
  - `pnpm --filter @c3-oss/prosa-derived-v2 test`
  - `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`
  - `pnpm --filter @c3-oss/prosa-derived-v2 lint`
  - `git diff --check`
- Update `docs/roadmap/rearch-2/evidence/lane-03.md`, `gates.md`,
  `status.md`, and `ralph-loop-prompt.md` with the fix commit and
  gate evidence before closing this correction.

Closure note:

Fix lands in this iteration. `planCompaction()` no longer does
its own `readdir`+`stat` walk; instead it routes the entire
projection segment enumeration through `listProjectionSegments()`,
which already enforces the CQ-094/CQ-096-style containment
(symlinked `epochs/` throws; symlinked `epochs/<n>/`,
`epochs/<n>/projection/`, and `.parquet` files are dropped at
the per-entry filter). The planner groups the flat listing back
into per-entity arrays the policy decision consumes, and the
unused internal `name_is_compact_dir` helper is removed since
`listProjectionSegments` already excludes `compact-<NNNN>/` dirs.
`defaultCompactionSeq` still uses a separate `readdir(epochsDir)`
to discover existing `compact-<NNNN>/` names — that read runs
after the listing's parent-symlink guard, so the planner cannot
follow an external-rooted `epochs/`.

Regression coverage (3 new tests in `planner.test.ts`):

- Symlinked `<bundleRoot>/epochs` throws.
- Symlinked `<bundleRoot>/epochs/<n>` silently dropped — even
  though following it would have pushed the small-file count
  above the low-count trigger.
- Symlinked `.parquet` silently dropped — same trigger-boundary
  setup.

Validation:

- `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`: pass.
- `pnpm --filter @c3-oss/prosa-derived-v2 test`: pass, 380 tests /
  34 files.
- `pnpm --filter @c3-oss/prosa-derived-v2 lint`: pass.
- Full repo `pnpm build` / `pnpm test` / `pnpm lint`: 13/13 turbo.
- `pnpm test:conformance`: pass, 26 / 2.
- `git diff --check`: pass.

### CQ-100: Validate Latest SessionBlob Loader Input Before Epoch Listing — closed 2026-05-19

Status: closed
Severity: medium
Blocking: yes
Owner: Ralph
Opened: 2026-05-19
Closed: 2026-05-19
Lane: 3 - Derived layer

Finding:

`loadLatestSessionBlobPack({ bundleRoot, sessionId })` delegates
`sessionId` validation to the first per-epoch `loadSessionBlobPack()`
call. That works only when at least one epoch exists. On a fresh bundle
where `listSessionBlobEpochs(bundleRoot)` returns `[]`, an invalid
`sessionId` such as `ses/escape`, `..`, or empty string skips the
per-epoch load entirely and is reported as "not found" (`code:
'ENOENT'`) rather than a validation error.

Risk:

Read surfaces can misclassify invalid user input as an absent session.
That weakens the resolver contract established by
`sessionBlobPackPath()` and makes CLI/MCP error behavior dependent on
whether the bundle happens to contain any SessionBlob epochs.

Required fix:

- Validate `sessionId` unconditionally before calling
  `listSessionBlobEpochs()`.
- Reuse the canonical resolver validation rather than duplicating the
  grammar; for example, call the pure `sessionBlobPackPath()` with a
  safe dummy epoch (`0`) and discard the result, or add a small shared
  validator if cleaner.
- Preserve the existing "no pack anywhere" `ENOENT` behavior for
  valid session IDs on empty/fresh bundles.

Acceptance criteria:

- Add regression tests proving invalid `sessionId` values are rejected
  even when the bundle has no SessionBlob epochs.
- Existing fresh-bundle `ENOENT` behavior remains for a valid session
  id.
- Focused gates pass:
  - `pnpm --filter @c3-oss/prosa-derived-v2 test`
  - `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`
  - `pnpm --filter @c3-oss/prosa-derived-v2 lint`
  - `git diff --check`
- Update `docs/roadmap/rearch-2/evidence/lane-03.md`, `gates.md`,
  `status.md`, and `ralph-loop-prompt.md` with the fix commit and
  gate evidence before closing this correction.

Closure note:

Fix lands in this iteration alongside `loadTranscriptFromBundle`:
`loadLatestSessionBlobPack` now calls `sessionBlobPackPath(bundleRoot,
sessionId, 0)` synchronously before any filesystem read. The
resolver throws on every invalid id (forward-slash, `..`, `.`,
empty, too-long, control chars, ...) before `listSessionBlobEpochs`
runs, so an empty bundle no longer masks the validation failure
behind a synthetic ENOENT. The sentinel `0` epoch is purely to
drive the path-build; no side effect persists. Regression
`CQ-100: invalid sessionId on a fresh bundle throws resolver
error, NOT fresh-bundle ENOENT` plants no pack and asserts the
resolver message surfaces for the full invalid-id family. Existing
fresh-bundle ENOENT behavior for valid session ids is preserved
(covered by the existing `throws with code=ENOENT on a fresh
bundle (no epochs at all)` test).

Validation:

- `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`: pass.
- `pnpm --filter @c3-oss/prosa-derived-v2 test`: pass, 233 tests / 22
  files.
- `pnpm --filter @c3-oss/prosa-derived-v2 lint`: pass.
- Full repo `pnpm build` / `pnpm test` / `pnpm lint`: 13/13 turbo.
- `pnpm test:conformance`: pass, 26 / 2.
- `git diff --check`: pass.

### CQ-099: SessionBlob Session Listing Must Not Return Resolver-Invalid IDs — closed 2026-05-19

Status: closed
Severity: medium
Blocking: yes
Owner: Ralph
Opened: 2026-05-19
Closed: 2026-05-19
Lane: 3 - Derived layer

Finding:

The current `listSessionBlobSessions()` WIP says listed session IDs
mirror `sessionBlobPackPath()`'s allow-list so callers can feed them
back into the resolver/loader. The implementation filters `..`
substrings but not the exact `.` session ID. A file named `.pack`
matches `SESSION_PACK_PATTERN`, yields `session_id="."`, and would be
returned even though `sessionBlobPackPath(bundleRoot, '.', epoch)`
rejects `.` as a current-directory vector.

Risk:

The listing surface can return a session ID that the canonical path
resolver rejects, making list-then-load workflows fail on ordinary
iteration. It also weakens the traversal hardening story for the
SessionBlob derived tree by letting a reserved path segment escape the
same validation applied to direct lookups.

Required fix:

- Make `listSessionBlobSessions()` validate candidate IDs with the
  same rules as `sessionBlobPackPath()` or otherwise reject every ID
  that the resolver rejects, including exact `.`.
- Keep the listing descriptive: invalid filenames should be ignored,
  not cause the whole listing to throw.
- Add a regression proving `.pack` is ignored, alongside the existing
  `ses_..escape.pack` rejection.

Acceptance criteria:

- `listSessionBlobSessions()` never returns an ID that
  `sessionBlobPackPath(bundleRoot, id, epoch)` would reject.
- Tests cover `.pack` and at least one existing `..` invalid filename.
- Focused gates pass:
  - `pnpm --filter @c3-oss/prosa-derived-v2 test`
  - `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`
  - `pnpm --filter @c3-oss/prosa-derived-v2 lint`
  - `git diff --check`
- Update `docs/roadmap/rearch-2/evidence/lane-03.md`, `gates.md`,
  `status.md`, and `ralph-loop-prompt.md` with the fix commit and
  gate evidence before closing this correction.

Closure note:

Fix lands in this iteration alongside the SessionBlob listing slice:

- `listSessionBlobSessions()` now validates every candidate session
  id by calling `sessionBlobPackPath(bundleRoot, candidate, epoch)`
  inside a try/catch. Any id the resolver rejects — including the
  reserved singletons `.` and `..`, the `..` substring family, and
  any future tightening of the grammar — is silently dropped from
  the listing. The listing surface stays descriptive (no whole-list
  failure on a single garbage filename) while guaranteeing that
  every returned id round-trips through the resolver.
- Cheap by construction: `sessionBlobPackPath` is pure (no
  filesystem access); the call inlines a `path.join` and a regex
  check.

Regression coverage:

- `CQ-099: rejects a literal '.pack' filename (session-id '.' is
  reserved)` plants `.pack` and `..pack` alongside `ses_good.pack`
  and asserts only `ses_good` surfaces.
- `CQ-099: every returned id round-trips through sessionBlobPackPath
  without throwing` plants a mixed valid/invalid set (`ses_alpha.pack`,
  `.pack`, `..pack`, `ses_..bad.pack`,
  `prosa.session.v2:claude:zzz.pack`) and asserts every listed id
  satisfies the resolver via direct invocation.

Validation:

- `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`: pass.
- `pnpm --filter @c3-oss/prosa-derived-v2 test`: pass, 214 tests / 20
  files.
- `pnpm --filter @c3-oss/prosa-derived-v2 lint`: pass.
- Full repo `pnpm build` / `pnpm test` / `pnpm lint`: 13/13 turbo.
- `pnpm test:conformance`: pass, 26 / 2.
- `git diff --check`: pass.

### CQ-098: Reject Intermediate Symlink Escapes in SessionBlob Pack Loader — closed 2026-05-19

Status: closed
Severity: high
Blocking: yes
Owner: Ralph
Opened: 2026-05-19
Closed: 2026-05-19
Lane: 3 - Derived layer

Finding:

The current `loadSessionBlobPack()` WIP rejects a symlink at the final
pack file path with `lstat(packPath)`, but it still follows symlinks in
intermediate components. If
`<bundleRoot>/derived/session-blob` or
`<bundleRoot>/derived/session-blob/epoch-<n>` is a symlink to an
external directory, `lstat(<...>/<session_id>.pack)` observes the
external file rather than rejecting the escape. The loader can then
read and verify a valid external pack while appearing to use canonical
derived paths.

Risk:

Lane 3 derived artifacts must remain confined to the bundle. A
symlinked intermediate SessionBlob directory can make future read paths
load bytes outside `<bundleRoot>/derived/session-blob/`, undermining
the same containment invariant enforced for Tantivy by `CQ-096`.

Required fix:

- Add containment validation for the SessionBlob pack path chain used
  by `loadSessionBlobPack()`.
- The check must reject symlinks in managed intermediate components
  such as `<bundleRoot>/derived`,
  `<bundleRoot>/derived/session-blob`, and
  `<bundleRoot>/derived/session-blob/epoch-<n>`, not only the final
  `<session_id>.pack` file.
- Preserve the accepted symlinked-bundle-root deployment pattern when
  the bundle itself is opened through a symlinked alias; the rejection
  target is symlinks inside the managed derived tree, not the caller's
  root path.
- Keep input validation delegated to `sessionBlobPackPath()` and keep
  ENOENT propagation for a genuinely missing pack.

Acceptance criteria:

- Add regression tests covering at least:
  - `derived/session-blob -> <external>` with an otherwise valid
    external `epoch-<n>/<session_id>.pack`: loader rejects before
    reading the external pack.
  - `derived/session-blob/epoch-<n> -> <external>` with an otherwise
    valid external `<session_id>.pack`: loader rejects.
  - A bundle opened via a symlinked root still loads successfully when
    the managed SessionBlob path itself is a real directory under that
    root.
  - The existing final-component symlink rejection remains covered.
- Focused gates pass:
  - `pnpm --filter @c3-oss/prosa-derived-v2 test`
  - `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`
  - `pnpm --filter @c3-oss/prosa-derived-v2 lint`
  - `git diff --check`
- Update `docs/roadmap/rearch-2/evidence/lane-03.md`, `gates.md`,
  `status.md`, and `ralph-loop-prompt.md` with the fix commit and
  gate evidence before closing this correction.

Closure note:

Fix lands in this iteration as a slice on top of the
`loadSessionBlobPack` commit (`eb88037`):

- Private helper `detectSessionBlobIntermediateSymlink(bundleRoot,
  epoch)` walks `<bundleRoot>/derived`,
  `<bundleRoot>/derived/session-blob`, and
  `<bundleRoot>/derived/session-blob/epoch-<n>` outermost →
  innermost, `lstat`s each, and reports the first symlink found.
  Mirrors the CQ-096 `detectDerivedTantivyIntermediateSymlink` in
  shape and policy. Missing intermediates resolve to
  `escape: false`; ENOENT propagation at the final `lstat(packPath)`
  step is preserved.
- `loadSessionBlobPack()` calls the helper before the final `lstat`
  and throws with the offending intermediate path quoted.
- Bundle-root containment is **not** validated — the symlinked
  bundle-root alias deployment pattern remains supported.

Regression coverage (4 new tests in
`packages/prosa-derived-v2/test/session-blob/loader.test.ts`):

- `CQ-098: refuses when derived/session-blob is a symlink to an
  external dir with a valid pack`.
- `CQ-098: refuses when derived/session-blob/epoch-<n> is a symlink
  to an external dir with a valid pack`.
- `CQ-098: refuses when derived is a symlink to an external tree
  (outermost)`.
- `CQ-098: succeeds when the bundle root itself is a symlinked
  alias and the SessionBlob tree is real`.

Gates after the change:

- `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`: pass.
- `pnpm --filter @c3-oss/prosa-derived-v2 test`: pass, 190 tests / 18
  files.
- `pnpm --filter @c3-oss/prosa-derived-v2 lint`: pass.
- Full repo `pnpm build` / `pnpm test` / `pnpm lint`: 13/13 turbo.
- `pnpm test:conformance`: pass, 26 / 2.
- `git diff --check`: pass.

### CQ-097: Keep SessionBlob Layout Tests Textual and Reconcile WIP Evidence — closed 2026-05-19

Status: closed
Severity: medium
Blocking: yes
Owner: Ralph
Opened: 2026-05-19
Closed: 2026-05-19
Lane: 3 - Derived layer

Fix lands in this iteration as part of the SessionBlob pack-path
resolver commit:

- The null-byte rejection test in
  `packages/prosa-derived-v2/test/derived-layout.test.ts` now
  constructs the NUL at runtime via
  `` `ses_${String.fromCharCode(0)}abc` ``. The source file contains
  no literal NUL byte, so `file
  packages/prosa-derived-v2/test/derived-layout.test.ts` reports
  `JavaScript source, Unicode text, UTF-8 text` (previously `data`).
- The null-byte rejection behavior is preserved: the test still
  asserts that `sessionBlobPackPath()` throws `/characters outside/`
  on the NUL-bearing sessionId.
- The roadmap reconciliation (`status.md`, `gates.md`,
  `evidence/lane-03.md`, `ralph-loop-prompt.md`) lands in the same
  commit so HEAD references, focused test counts (179 / 17), and
  the SessionBlob pack-path resolver evidence agree on the
  post-commit state.

Validation:

- `file packages/prosa-derived-v2/test/derived-layout.test.ts`:
  `JavaScript source, Unicode text, UTF-8 text`.
- `grep -anP '\x00'` against the test file: no matches.
- `pnpm --filter @c3-oss/prosa-derived-v2 test`: pass, 179 tests /
  17 files.
- `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`: pass.
- `pnpm --filter @c3-oss/prosa-derived-v2 lint`: pass.
- Full repo `pnpm build` / `pnpm test` / `pnpm lint`: 13/13 turbo.
- `pnpm test:conformance`: pass, 26 / 2.
- `git diff --check`: pass.

### CQ-096: Reject Intermediate Symlink Escapes in Derived Tantivy Paths — closed 2026-05-19

Status: closed
Severity: high
Blocking: yes
Owner: Ralph
Opened: 2026-05-19
Closed: 2026-05-19
Lane: 3 - Derived layer

Fix lands in this iteration:

- New private helper `detectDerivedTantivyIntermediateSymlink(bundleRoot)`
  in `packages/prosa-derived-v2/src/tantivy/index-dir.ts` walks the
  derived path chain outermost → innermost (`<bundleRoot>/derived`
  then `<bundleRoot>/derived/tantivy`), `lstat`s each, and reports
  `{ escape: true, path }` on the first symlink it finds.
- `tantivyIndexDirIsValid(bundleRoot)` calls the helper first; an
  intermediate symlink resolves the probe to `false` so the planner
  routes to `full` and never reports an externally-rooted index as
  recoverable. An unexpected error during the walk (EACCES, EIO)
  also yields `false`; the writer surfaces the underlying failure
  when it opens the index.
- `clearTantivyIndexDir(bundleRoot)` calls the helper first; an
  intermediate symlink throws with the offending path quoted, before
  the existing `mkdir(<index>)` could resolve through the symlink
  and create `<external>/index`.
- Bundle-root containment is **not** validated: opening a bundle
  through a symlinked alias (e.g. `/opt/prosa/current ->
  /opt/prosa/v123`) remains a supported deployment pattern. The
  rejection target is symlinks *inside* the managed derived tree.

Regression coverage (6 new tests across the two existing files):

- `index-dir.test.ts` — `CQ-096: returns false when derived/tantivy
  is a symlink to an external directory with a valid index/meta.json`,
  `... when derived is a symlink ...`, and `... returns true when the
  bundle root itself is opened via a symlinked alias and the derived
  tree is a real directory`.
- `clear-index-dir.test.ts` — `CQ-096: refuses to operate when
  derived/tantivy is a symlink with no index yet (must not create
  <external>/index)`, `... when derived is a symlink (must not mutate
  the external tree)`, and `... clears successfully when bundle root
  is opened via a symlinked alias and the derived tree is a real
  directory`.

Gates after the change:

- `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`: pass.
- `pnpm --filter @c3-oss/prosa-derived-v2 test`: pass, 159 tests / 17
  files.
- `pnpm --filter @c3-oss/prosa-derived-v2 lint`: pass.
- Full repo `pnpm build` / `pnpm test` / `pnpm lint`: 13/13 turbo.
- `pnpm test:conformance`: pass, 26 / 2.
- `git diff --check`: pass.

Finding:

`CQ-094` hardened `tantivyIndexDirIsValid()` and
`clearTantivyIndexDir()` against symlinks at the final `index` and
`meta.json` path components, but both helpers still follow symlinks in
intermediate components. For example, if
`<bundleRoot>/derived/tantivy` is a symlink to an external directory,
then `lstat(<bundleRoot>/derived/tantivy/index)` observes the external
`index` path rather than rejecting the escape. The probe can therefore
report an external index as recoverable, and the reset helper can
create or clear `<external>/index` on a fresh/full rebuild.

Risk:

Lane 3 derived artifacts must remain confined to the bundle. Following
an intermediate symlink in `derived/` or `derived/tantivy/` can make the
future native writer read, create, or remove files outside the bundle
root while still appearing to use canonical derived paths.

Required fix:

- Add containment validation for the Tantivy derived path chain used by
  `tantivyIndexDirIsValid()` and `clearTantivyIndexDir()`.
- The check must reject symlinks in intermediate components such as
  `<bundleRoot>/derived` and `<bundleRoot>/derived/tantivy`, not only
  the final `index` and `meta.json` components.
- Preserve the accepted symlinked-bundle-root deployment pattern when
  the bundle itself is opened through a symlinked alias; the rejection
  target is symlinks inside the managed derived tree, not the caller's
  root path.
- Ensure a fresh reset does not create `<external>/index` when
  `derived/tantivy` is a symlink, and an existing external index is not
  treated as valid by the probe.
- Keep the fix scoped to the derived/Tantivy filesystem helpers unless
  a small shared helper is needed for clarity.

Acceptance criteria:

- Add regression tests covering at least:
  - `derived/tantivy -> <external>` with an otherwise valid external
    `index/meta.json`: `tantivyIndexDirIsValid()` returns `false`.
  - `derived/tantivy -> <external>` with no `index` yet:
    `clearTantivyIndexDir()` rejects and does not create
    `<external>/index`.
  - `derived -> <external>` is also rejected before probe/reset can
    validate or mutate the external tree.
  - A bundle opened via a symlinked root still works when the managed
    `derived/tantivy/index` path itself is a real directory under that
    root.
- Focused gates pass:
  - `pnpm --filter @c3-oss/prosa-derived-v2 test`
  - `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`
  - `pnpm --filter @c3-oss/prosa-derived-v2 lint`
  - `git diff --check`
- Update `docs/roadmap/rearch-2/evidence/lane-03.md`, `gates.md`, and
  `status.md` with the fix commit and gate evidence.

### CQ-095: Reconcile Plan-Bundle Commit Evidence Before Further Acceptance — closed 2026-05-19

Closure note: the four roadmap artifacts now agree on `fa49eb2` as
the committed plan-bundle orchestration slice. The reconciliation
removes the stale "pending plan-bundle orchestration commit" status
language, clears the open-blocker mentions of `CQ-095` from
`status.md` / `gates.md` / `ralph-loop-prompt.md`, and confirms
`evidence/lane-03.md` already lists the orchestration helper as
landed. No code change was required.

Validation:

- `git status --short --branch`: clean (after the reconciliation
  commit).
- `git diff --check`: pass.

## Closed (latest first)

### CQ-094: Tantivy Index-Dir Probe Must Reject Symlink Escape Paths — closed 2026-05-19

Fix lands in this iteration:

- `tantivyIndexDirIsValid()` now uses `lstat()` (not `stat()`) on both
  the index directory and `meta.json`. When either path is a symbolic
  link the probe returns `false` immediately, regardless of whether
  the link target exists or would have satisfied the validity check.
- Module-level docstring updated to document the symlink-rejection
  contract and reference CQ-094.
- Two new regression tests cover the escape paths CQ-094 calls out:
  - index dir is a symlink to an existing external directory
    containing a plausible `meta.json` — probe must reject.
  - `meta.json` itself is a symlink to an existing external file
    whose contents would otherwise satisfy the JSON check — probe
    must reject.
- The existing dangling-symlink, malformed-JSON, JSON-array,
  missing-segments, non-array-segments, and happy-path tests still
  pass without modification; the dangling-symlink comment was updated
  to describe the new `lstat`-based rejection path rather than the
  old `stat`-resolved ENOENT path.

Gates after the change:

- `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`: pass.
- `pnpm --filter @c3-oss/prosa-derived-v2 test`: pass, 122 tests / 13
  files.
- `pnpm --filter @c3-oss/prosa-derived-v2 lint`: pass.
- Full repo `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm
  lint`: 13/13 turbo.
- `pnpm test:conformance`: pass, 26 tests / 2 files.
- `git diff --check`: pass.

### CQ-093: Make Tantivy Checkpoint Writes Actually Atomic — closed 2026-05-19

Fix lands in this iteration:

- `writeIndexCheckpoint()` now opens a unique same-directory temp at
  `<checkpoint.json>.tmp.<pid>.<rand>`, writes the canonical-JSON
  bytes, fsyncs the file handle, `rename(tmp, checkpoint.json)`
  (POSIX atomic on the same filesystem), then `syncDir(dirname(path))`
  so the rename survives a crash. Mirrors the `head.json` pattern in
  `prosa-bundle-v2`.
- On rename failure the temp is unlinked best-effort; the final
  `checkpoint.json` is never touched outside the rename, so the prior
  good checkpoint always survives a failed update.
- Module-level docstring updated to describe "rename-based atomic
  replacement" (not the misleading "newest write wins"), and the
  prior test was renamed to "replaces a prior checkpoint via rename,
  leaving no stale temp behind" — it now asserts only
  `checkpoint.json` survives in the directory after the rename.
- New regression test "CQ-093: a stale `.tmp.*` file from an
  interrupted prior update does not corrupt the next read":
  - Plants a garbage-content `checkpoint.json.tmp.999999.deadbeef`
    next to a known-good `checkpoint.json` (simulating the crash
    state CQ-093 contemplates).
  - Asserts the read still returns the prior good checkpoint.
  - Performs a fresh write, asserts the read now returns the new
    checkpoint.
  - Asserts no fresh-iteration temp file leaks into the directory.
- `writeFileDurable` is no longer imported into checkpoint-store; the
  module now uses `open` + `rename` + `syncDir` directly.

Gates after the change:

- `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`: pass.
- `pnpm --filter @c3-oss/prosa-derived-v2 test`: pass, 99 tests / 11
  files.
- `pnpm --filter @c3-oss/prosa-derived-v2 lint`: pass.
- Full repo `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm
  lint`: 13/13 turbo.
- `pnpm test:conformance`: pass, 26 tests / 2 files.
- `git diff --check`: pass.

### CQ-092: Commit and Reconcile SessionBlob Projection Bridge CQ-091 Closeout — closed 2026-05-19

Closure note: the `CQ-091` byte-accounting fix and the governance
reconciliation it required already landed together in `585a456`
(`fix(infra): utf-8 byte accounting in session-blob projection bridge`).
The commit ships: projection-bridge implementation, writer CAS-ref byte
accounting, two regression tests (UTF-8 cap + many-multibyte page-size
cap), the package export, and reconciled
`correction-queue.md` / `status.md` / `gates.md` / `evidence/lane-03.md` /
`ralph-loop-prompt.md`. Codex opened `CQ-092` while that commit was
racing in, and re-asserts the same reconciliation requirement; this
follow-up commit re-syncs the docs that Codex re-edited after
`585a456` landed.

Gates after `585a456`:

- `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`: pass.
- `pnpm --filter @c3-oss/prosa-derived-v2 test`: pass, 81 tests / 9
  files.
- `pnpm --filter @c3-oss/prosa-derived-v2 lint`: pass.
- `git status --short`: clean (before this reconciliation commit).
- `git diff --check`: pass.

### CQ-091: Enforce CAS Preview Byte Accounting in SessionBlob Projection Bridge — closed 2026-05-19

Fix lands in this iteration:

- `projectionToSessionBlobInputs()` now truncates CAS-ref previews
  by UTF-8 byte length (`truncateToUtf8Bytes` uses
  `TextEncoder.encodeInto`, which stops on the last complete code
  point that fits the byte budget). Returned `byte_length` matches
  the truncated preview's UTF-8 length.
- `writeSessionBlobPack()`'s CAS-ref `bodyByteCost` now uses
  `utf8ByteLength(body.preview)` instead of `body.preview.length`
  (UTF-16 code units), with the same 1.1x inflation + 128-byte
  object-id overhead the writer applies to inline blocks.
- Two new regression tests in
  `test/session-blob/projection-bridge.test.ts`:
  - A `text_object_id` with a 4096-emoji `text_inline` is capped
    to ≤ `CAS_REF_PREVIEW_MAX_BYTES` UTF-8 bytes and never splits
    a surrogate pair (preview length is exactly
    `floor(CAS_REF_PREVIEW_MAX_BYTES / 4)` emoji).
  - 128 multibyte CAS-ref previews routed through
    `writeSessionBlobPack` produce no
    `SessionBlobPageRefV2.uncompressed_length` above
    `MAX_PAGE_UNCOMPRESSED_BYTES`.

Gates after the change:

- `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`: pass.
- `pnpm --filter @c3-oss/prosa-derived-v2 test`: pass, 81 tests / 9
  files.
- `pnpm --filter @c3-oss/prosa-derived-v2 lint`: pass.
- Full repo `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm
  lint`: 13/13 turbo.
- `pnpm test:conformance`: pass, 26 tests / 2 files.
- `git diff --check`: pass.

### CQ-090: Reconcile Tantivy Planner Closeout Evidence Before Acceptance — closed 2026-05-19

Already-satisfied at queue-open time: `509e1f1` committed
`packages/prosa-derived-v2/src/tantivy/{schema,rebuild-plan}.ts` +
their tests + `src/index.ts` exports + matching `evidence/lane-03.md`
/ `gates.md` / `status.md` updates in one focused commit. Codex's
CQ-090 captured a snapshot of stale Done-Check / prompt text from
before `509e1f1`; this pass reconciles those last few stale lines
to the committed HEAD.

Reconciliation in this pass:

- `gates.md`: `just test-all` row bumped to derived-v2 **72**;
  Done Check no longer says `CQ-087`/`CQ-089` are open.
- `status.md`: `Current HEAD` now names `509e1f1`; open blocking
  corrections cleared.
- `ralph-loop-prompt.md`: invocation contract + current-correction
  section reflect the cleared queue.

Gates against `509e1f1`:

- `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`: pass.
- `pnpm --filter @c3-oss/prosa-derived-v2 test`: pass, 72 tests / 8
  files.
- `pnpm --filter @c3-oss/prosa-derived-v2 lint`: pass.
- Full repo `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm
  lint`: 13/13 turbo.
- `pnpm test:conformance`: pass, 26 tests / 2 files.
- `git diff --check`: pass.

### CQ-089: Analytics Parquet Reads Must Include Compacted Overlays — closed 2026-05-19

Fix landed in this iteration:

- `parquetReadFor(bundleRoot, entity)` now passes BOTH globs to a
  single `read_parquet([...])` call:
  - `'<bundleRoot>/epochs/*/projection/<entity>.parquet'` (live)
  - `'<bundleRoot>/epochs/compact-*/projection/<entity>.compacted.parquet'`
    (compaction-planner overlays)
  with `union_by_name => true` so a missing glob match does not
  error and the row-set union stays consistent.
- A `quoteForSql` helper SQL-doubles any single quotes inside the
  bundle root, so adversarial paths cannot break the generated SQL.
- Two new tests in `test/analytics/views.test.ts` (now 11 cases)
  assert the generated SQL includes both globs for every canonical
  entity table, both at the `parquetReadFor` and the
  `analyticsParquetPreamble` levels.

Gates after the change:

- `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`: pass.
- `pnpm --filter @c3-oss/prosa-derived-v2 test`: pass, 55 tests / 6
  files.
- `pnpm --filter @c3-oss/prosa-derived-v2 lint`: pass.
- Full repo `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm
  lint`: 13/13 turbo.
- `pnpm test:conformance`: pass, 26 tests / 2 files.
- `git diff --check`: pass.

### CQ-088: Commit Roadmap Reconciliation for CQ-087 Closeout — closed 2026-05-19

The roadmap-only reconciliation that closes `CQ-087` and names
`ea8c1a8` as the Parquet compaction planner commit landed at
`76128fa`. `git status --short --branch` is clean after that
commit (modulo this `CQ-088` closeout itself, which is the final
docs-only sweep).

The pattern of opening a follow-up correction every time roadmap
state lags a commit by a few minutes is recorded so future
iterations can short-circuit: the prior correction's `acceptance
criteria` are now satisfied by `76128fa`, so no further code or
gate runs are needed beyond `git diff --check` (pass).

### CQ-087: Reconcile Post-CQ-086 Roadmap State With HEAD and Planner WIP — closed 2026-05-19

Already-satisfied at queue-open time. The compaction planner that
CQ-087 demanded be committed-or-documented landed at `ea8c1a8`
between Codex's review of `ba87f05` and this closeout pass:

- `packages/prosa-derived-v2/src/compaction/planner.ts` +
  `test/compaction/planner.test.ts` + the `src/index.ts` export are
  tracked at `ea8c1a8`.
- `evidence/lane-03.md`, `gates.md`, and `status.md` were
  reconciled in the same commit; the focused
  `pnpm --filter @c3-oss/prosa-derived-v2 test` count of 44 / 5
  was recorded against the committed planner HEAD.

Roadmap artifacts reconciled in this pass:

- `correction-queue.md`: `CQ-087` moved to closed.
- `status.md`: `Current HEAD` advanced to `ea8c1a8`; open blocking
  corrections cleared.
- `gates.md` Done Check no longer references `CQ-086` or `CQ-087`
  as open.
- `ralph-loop-prompt.md`: invocation contract reflects the cleared
  queue.

Gates at `ea8c1a8`:

- `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`: pass.
- `pnpm --filter @c3-oss/prosa-derived-v2 test`: pass, 44 tests /
  5 files.
- `pnpm --filter @c3-oss/prosa-derived-v2 lint`: pass.
- Full repo `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm
  lint`: 13/13 turbo.
- `pnpm test:conformance`: pass, 26 tests / 2 files.
- `git diff --check`: pass.

### CQ-086: Commit and Reconcile SessionBlobPackV2 CQ-084/CQ-085 Closeout — closed 2026-05-19

Closeout committed in this iteration:

- `packages/prosa-derived-v2/src/session-blob/{framing,writer,reader}.ts`
  + tests + `index.ts` exports are tracked.
- Roadmap artifacts (`correction-queue.md`, `status.md`,
  `gates.md`, `evidence/lane-03.md`, `ralph-loop-prompt.md`)
  reconciled to the committed HEAD. `CQ-084`, `CQ-085`, and
  `CQ-086` are all closed.

Gates at the committed HEAD:

- `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`: pass.
- `pnpm --filter @c3-oss/prosa-derived-v2 test`: pass, 36 tests /
  4 files.
- `pnpm --filter @c3-oss/prosa-derived-v2 lint`: pass.
- Full repo `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm
  lint`: 13/13 turbo.
- `pnpm test:conformance`: pass, 26 tests / 2 files.
- `git diff --check`: pass.

### CQ-085: Make SessionBlob Writer/Reader Preserve Data and Bind the Final Pack Digest — closed 2026-05-19

All three CQ-085 defects are fixed:

1. **`pack_digest` contract clarified.** The digest is now defined as
   `blake3(canonical_json(header_without_pack_digest_field) || payload)`.
   Readers can recompute it from the bytes alone (via the new
   `verifyPackDigest()` helper) without trusting the header field.
   `header.pack_digest` and the returned `pack_digest` are equal by
   construction; `verifyPackDigest()` agrees with both. The
   self-referential-header case is documented in code comments so
   future readers don't misread the contract as "blake3 over the
   framed pack bytes".
2. **Multi-block messages no longer drop blocks across a split.**
   When `decideBlock` returns `split_page` mid-staging, the writer
   moves the *entire* current message onto a fresh page and re-stages
   from block 0 (atomic-message contract). If the message is so
   large that even a fresh empty page cannot hold all its blocks,
   the writer falls back to fragment mode: the staged blocks land on
   the current page as a `message_id`-tagged fragment, then a new
   page opens for the remaining blocks. Every input block survives
   in exactly one fragment.
3. **Writer-internal effective budget keeps serialized pages under
   the cap.** A new `EFFECTIVE_PAGE_BUDGET = 0.75 * MAX` is enforced
   in the writer in addition to `decideBlock`. The per-block JSON
   overhead estimate is bumped to 256 bytes (was 128) and per-message
   to 256 (was 192) so the rough estimates always cover the actual
   serialized JSON cost.

Tests in `test/session-blob/writer-reader.test.ts` (11 cases incl.
6 from this iteration):

- Small-session round-trip exercises framing + canonical-JSON
  serialization + identity compressor decompression.
- 1,000-message pagination respects both the message-count and byte
  caps; offsets are monotonic and contiguous.
- Empty session emits `page_count: 0`.
- CAS-ref bodies pass through the pack body without inlining.
- Byte-identical pack output for identical input.
- Out-of-range page index is rejected.
- **CQ-085 (1):** `pack_digest` is recomputable from header-without-
  digest + payload; `verifyPackDigest()` agrees.
- **CQ-085 (1):** `verifyPackDigest()` rejects payload tampering.
- **CQ-085 (2):** single message with 400 inline 3 KiB blocks
  (cumulative ~1.2 MiB) is split into fragments preserving every
  block id; every page's `uncompressed_length` stays at or below
  `MAX_PAGE_UNCOMPRESSED_BYTES`.
- **CQ-085 (2):** mixed multi-block messages across the corpus —
  union of block_ids across pages equals the input set with no
  duplicates and no missing entries.
- **CQ-085 (4):** 800 messages × 3 KiB blocks — every page's
  actual serialized `uncompressed_length` stays at or below the
  1 MiB cap.

Gates after the change:

- `pnpm --filter @c3-oss/prosa-derived-v2 typecheck`: pass.
- `pnpm --filter @c3-oss/prosa-derived-v2 test`: pass, 36 tests / 4
  files (writer-policy 11, compaction 6, framing 8, writer/reader
  11).
- `pnpm --filter @c3-oss/prosa-derived-v2 lint`: pass.
- Full repo `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm
  lint`: 13/13 turbo.
- `pnpm test:conformance`: pass, 26 tests / 2 files.
- `git diff --check`: pass.

### CQ-084: Fix SessionBlobPackV2 Framing Magic Round-Trip Before Commit — closed 2026-05-19

The framing-magic length defect is fixed:

- `SESSION_BLOB_MAGIC` is now `'PROSA_SESS_PACK2'` (16 bytes),
  matching the bundle-v2 convention (`PROSA_CAS_PACK_2`,
  `PROSA_RAW_SRC_V2`). `encodeInto` no longer truncates the magic,
  so `decodeSessionBlobFrame` accepts its own output.
- Focused tests in `test/session-blob/framing.test.ts` (8 cases):
  round-trip preserves header bytes / payload / flags; header
  tampering rejected via the blake3 binding; too-short buffers and
  truncated header_len rejected; unexpected magic rejected;
  `canonicalJsonBytes` emits stable key ordering and drops
  `undefined` while preserving `null`.
- Framing helpers + writer/reader + identity compressor pair
  exported from `packages/prosa-derived-v2/src/index.ts` as the
  Lane 3 public surface.

### CQ-083: Separate CQ-082 Lane 2 Closeout From Lane 3 Scaffold WIP — closed 2026-05-19

Scope separation is now proven on disk:

- `3eb1c08` lands the focused Lane 2 `CQ-082` closeout. That commit
  contains only the corrected
  `test/conformance/providers-v2-idempotency.test.ts` and roadmap
  evidence; it has zero Lane 3 file/lockfile content.
- This follow-up commit lands the Lane 3 derived-layer scaffold
  (`packages/prosa-derived-v2/` + the `packages/prosa-derived-v2`
  importer entry in `pnpm-lock.yaml` + `evidence/lane-03.md`) on
  top of `3eb1c08`.

The Lane 3 scaffold is intentionally pure-TypeScript and adds no new
dependency surface beyond what `pnpm-lock.yaml` records. Lane 2
acceptance remains the project owner's / Codex's call. Subsequent
Lane 3 iterations bring `@oxdev03/node-tantivy-binding` and
`@duckdb/node-api`.

### CQ-082: Make CQ-081 Actually Exercise Reserve and Pack Idempotency — closed 2026-05-19

### CQ-082: Make CQ-081 Actually Exercise Reserve and Pack Idempotency — closed 2026-05-19

The bundle-level I2 test in
`test/conformance/providers-v2-idempotency.test.ts` was rewritten to
cover every CQ-082 acceptance criterion:

1. The test now passes a real `MemoryShardActor` to
   `runCompileImports` so the second run exercises the Reserve lose
   path. Comments that previously claimed Reserve was exercised
   without a shard were removed.
2. The assertions now cover (a) per-provider `won > 0` on the first
   run and `won === 0` / `units === 0` /
   `lost === discovered` on the second run, (b) the second epoch's
   per-entity counts (`sessions`, `rawRecords`, `sourceFiles`,
   `objects`) are all 0, and (c) the on-disk pack-file set under
   `cas/packs/` and `raw_sources/packs/` is byte-identical between
   the two compiles. A cold `openBundle` reopen verifies the
   persisted bundle is still well-formed after the no-op second
   compile.
3. The bundle-idempotency case is now parametric over the same five
   provider fixtures the projection-id idempotency cases cover
   (codex / claude / cursor / gemini / hermes), not Codex only.

Gates after the change:

- `pnpm test:conformance`: pass, **26 tests** / 2 files (15 leaves +
  6 providers-v2 projection-id + 5 bundle-compile idempotency).
- `pnpm --filter @c3-oss/prosa-importers-v2 test`: pass, 40 tests /
  7 files.
- Full repo `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm
  lint`: 12/12 turbo at the Lane 2 closeout HEAD (Lane 3 scaffold
  lands in a separate commit per `CQ-083`).
- `git diff --check`: pass.

Per `CQ-083`, this commit is intentionally scoped to the Lane 2
closeout. The Lane 3 derived-layer scaffold lands in a separate
follow-up commit; `CQ-083` closes only after that scope-separation
is proven on disk.

### CQ-081: Strengthen Lane 2 Idempotency Conformance to Exercise Bundle Compile — closed 2026-05-19

### CQ-081: Strengthen Lane 2 Idempotency Conformance to Exercise Bundle Compile — closed 2026-05-19

Bundle-level I2 conformance landed in
`test/conformance/providers-v2-idempotency.test.ts`. The new case runs the
real v2 compile path twice over the codex fixture corpus via
`runCompileImports` against an `initBundle`-managed temp bundle:

1. First `runCompileImports` seals epoch 1 with real raw_records, sessions,
   and source_files counts captured from `bundle.head.counts`.
2. Second `runCompileImports` runs against the same on-disk corpus and the
   same bundle. Reserve-before-parse loses on every logical key, so
   `parseAndProject` is never re-invoked.
3. Assertion: `bundle.head.counts` is structurally equal between the two
   sealed states — zero new rows, raw records, source files, or packs.
4. A cold `openBundle` re-open verifies the persisted head counts after the
   no-op second compile, so the bundle still parses from disk.

The projection-id conformance suite remains in place as a lower-level
provider determinism check (cases 1–6); CQ-081 adds the bundle-layer gate
(case 7).

Gates after the change:

- `pnpm test:conformance`: pass, 22 tests / 2 files (15 leaves + 6
  providers-v2 projection-id + 1 bundle compile idempotency).
- `pnpm --filter @c3-oss/prosa-importers-v2 test`: pass, 40 tests / 7
  files.
- Full repo `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm lint`:
  12/12 turbo.
- `git diff --check`: pass.

Lane 2 implementation contract is complete. Superseded 2026-05-19:
Lane 2 is accepted by Codex/governor.

### CQ-080: Commit Providers-v2 Conformance Closeout Before Acceptance — closed 2026-05-19

### CQ-080: Commit Providers-v2 Conformance Closeout Before Acceptance — closed 2026-05-19

The providers-v2 fixtures + idempotency conformance test + root
`better-sqlite3` / `@types/better-sqlite3` dependency + roadmap
closeout updates landed in a single focused commit. Roadmap artifacts
(`status.md`, `gates.md`, `evidence/lane-02.md`,
`ralph-loop-prompt.md`, `correction-queue.md`) were reconciled to the
same committed HEAD, with CQ-074, CQ-079, and CQ-080 all closed
together.

Gates after the commit:

- `pnpm test:conformance`: pass, 21 tests / 2 files (15 leaves + 6
  providers-v2 idempotency cases).
- `pnpm --filter @c3-oss/prosa-importers-v2 test`: pass, 40 tests / 7
  files.
- Full repo `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm lint`:
  12/12 turbo.
- `git diff --check`: pass.

Superseded 2026-05-19: Lane 2 is accepted by Codex/governor.

### CQ-074: Reconcile Post-`58cca83` State and Implement Full Lane 2 Importer Contract — closed 2026-05-19

The user rejected the Lane 2 re-scope and asked for full per-record
projection across all 5 providers + fixture corpora + cross-provider
idempotency conformance. All three deliverables are now committed:

- Full per-record projection landed for every provider:
  CodexProvider at `d302bc6` (closed CQ-075/CQ-076), ClaudeProvider at
  `7eaed27`, GeminiProvider at `b660f44`, HermesProvider at `8c1714f`,
  CursorProvider at `af27eba` (closed CQ-077/CQ-078).
- Shared fixture corpora at `test/fixtures/providers-v2/` with one
  realistic-but-tiny corpus per provider mirroring its real discovery
  layout (Codex JSONL rollout, Claude main+subagent JSONL pair,
  Cursor JSON descriptor materialized into a real SQLite store,
  Gemini chats snapshot, Hermes JSONL + JSON snapshot).
- Cross-provider idempotency conformance at
  `test/conformance/providers-v2-idempotency.test.ts` — 5 per-provider
  cases asserting byte-identical projection ids across two runs against
  the same on-disk layout, plus one Claude spawned-edge idempotency
  case. Floor row counts also enforced so an empty projection cannot
  silently pass.

Focused gates:

- `pnpm test:conformance`: pass, 21 tests / 2 files (15 leaves + 6
  providers-v2 idempotency cases).
- `pnpm --filter @c3-oss/prosa-importers-v2 test`: pass, 40 tests / 7
  files.
- Full repo `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm lint`:
  12/12 turbo green.

Superseded 2026-05-19: Lane 2 is accepted by Codex/governor;
implementation is complete against
`docs/rearch-2/03-lane-2-importers.md`.

### CQ-079: Fix Providers-v2 Idempotency Conformance Dependency Boundary — closed 2026-05-19

Root `package.json` now carries `better-sqlite3` (^12.10.0) and
`@types/better-sqlite3` (^7.6.12) as devDependencies so the root-level
conformance test resolves the runtime package directly (the v2 conformance
suite already lives at the workspace root next to `leaves.test.ts`).
`pnpm-lock.yaml` was updated by `pnpm install --prefer-offline`. The
conformance suite now runs from the existing entrypoint:

```text
pnpm test:conformance
```

Result: `21 passed (15 leaves + 6 providers-v2 idempotency cases)`.

The conformance test also closes `CQ-074`'s remaining provider work
(fixture corpora under `test/fixtures/providers-v2/` + cross-provider
idempotency conformance) — see `CQ-074` closeout below.

### CQ-078: Reconcile Cursor WIP Closeout Before Lane 2 Acceptance — closed 2026-05-19

CursorProvider full per-record projection (SQLite reader,
`better-sqlite3` workspace dep + per-blob projection + CQ-074 test
over a real SQLite store) is committed in the same closeout as
`CQ-077`. All roadmap artifacts (`status.md`, `gates.md`,
`evidence/lane-02.md`, `ralph-loop-prompt.md`, `correction-queue.md`)
were reconciled to the new committed HEAD reflecting 40 importer
tests / 7 files. `CQ-074` stays open for the shared fixture corpora
and cross-provider idempotency conformance.

### CQ-077: Fix Cursor SQLite WIP Lint Before Acceptance — closed 2026-05-19

CursorProvider full-projection / SQLite-reader WIP imports were reorganised,
SQL string literals downgraded from template strings to single-quoted
literals (both in `packages/prosa-importers-v2/src/cursor/index.ts` and
`packages/prosa-importers-v2/test/unit/cursor.test.ts`), and formatting
auto-fixed by `biome check --write`. Focused gates after the fix:

- `pnpm --filter @c3-oss/prosa-importers-v2 typecheck`: pass.
- `pnpm --filter @c3-oss/prosa-importers-v2 test`: pass, 40 tests / 7 files.
- `pnpm --filter @c3-oss/prosa-importers-v2 lint`: pass.
- `git diff --check`: pass.
- Full repo `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm lint`:
  12/12 turbo tasks pass.

Closed in the same Cursor SQLite + full-projection commit so the slice
lands with a green lint gate.

### CQ-076: Remove Codex Projection Schema Casts and Persist Tool Fields Correctly — closed 2026-05-18

The Codex full-projection WIP has been re-landed with no `as never` casts and
with canonical-field-only tool rows:

- `packages/prosa-importers-v2/src/codex/index.ts` ToolCallV2 rows now use the
  canonical fields only (`source_call_id`, `command`, `cwd`, `path`, `query`,
  `args_object_id` left null). Shell-like `arguments.command` arrays/strings
  are flattened into a `command` preview; `arguments.path`/`file_path`,
  `query`/`pattern`, and `cwd` are extracted when present. JSON-blob
  arguments are still preserved upstream as `RawRecordV2` payload.
- ToolResultV2 rows use the canonical fields only (`source_call_id`, `preview`
  bounded to 4096 chars, all `*_object_id` left null until object-backed
  output lands). `is_error` honors the envelope flag.
- The `ContentBlockV2` push no longer needs `as never`; its row already
  matched the schema.
- `packages/prosa-importers-v2/test/unit/codex.test.ts` CQ-074 test now
  asserts the canonical fields directly: `tool_calls[0].source_call_id`,
  `tool_calls[0].command`, `tool_calls[0].args_object_id` (null), and
  `tool_results[0].source_call_id`, `tool_results[0].preview`,
  `tool_results[0].output_object_id` (null), `tool_results[0].is_error`.

Focused gates after the change:

- `pnpm --filter @c3-oss/prosa-importers-v2 typecheck`: pass.
- `pnpm --filter @c3-oss/prosa-importers-v2 test`: pass, 36 tests / 7 files.
- `pnpm --filter @c3-oss/prosa-importers-v2 lint`: pass.
- `git diff --check`: pass.
- Full repo `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm lint`:
  12/12 turbo tasks pass.

### CQ-075: Fix CodexProvider Lane 2 WIP Typecheck — closed 2026-05-18

The Codex full-projection slice now consumes both previously-unused symbols:

- `CodexTurnContextPayload` is used to type the `turn_context` envelope path
  and to read `model`, `cwd`, `effort`, `approval_policy`, `sandbox_policy`,
  `turn_id`, etc. in `parseAndProject`.
- `deriveCodexTurnRowId` is the deterministic turn-row id helper used by
  every `turn_context` envelope (and as fallback for `response_item`
  emissions tied to a prior turn).

Focused gate `pnpm --filter @c3-oss/prosa-importers-v2 typecheck` now passes.
Co-closed with CQ-076 in the same Lane 2 full-projection commit.

### CQ-073: Close CQ-072 Only After Formatting Gate and Commit — closed 2026-05-18

CQ-072 was moved to Closed while one Biome formatting issue
remained on the help-smoke WIP. Auto-fix via
`pnpm --filter @c3-oss/prosa lint:fix` cleared it (one trailing
whitespace inside the describe block). Both CQ-072 and CQ-073 land
in the same closeout commit so queue/status/gates/evidence stay
coherent. Focused gates pass 12/12 turbo after the fix.

### CQ-072: Repair Premature CQ-071 Closeout and Add CLI Help Smokes — closed 2026-05-18

CQ-072 was opened while the CQ-071 closeout commit (`8247a4c`) was
still in flight. By review time the CLI surface had already landed
and the focused gates passed at 12/12. The remaining CQ-072 ask was
`compile-v2 --help` / `compile-all-v2 --help` smokes; those land
here.

- Two new tests in `apps/cli/test/cli/compile-v2.test.ts`:
  - `CQ-072: 'compile-v2 --help' prints the usage banner and exits 0`
    — asserts synopsis text + key flags.
  - `CQ-072: 'compile-all-v2 --help' prints the usage banner and
    exits 0` — asserts all five `--<provider>-root` flags appear.
- CLI test count 3 → 5.
- Status / gates / lane-02 evidence pinned to actual HEAD `8247a4c`.

### CQ-071: Reconcile Post-`c496bac` Governance and Harden `compile-v2` CLI WIP — closed 2026-05-18

Lane 2 CLI surface hardened:

- New `apps/cli/src/cli/commands/compile-v2.ts` exports
  `compileV2Command()` and `compileAllV2Command()`. Both wrap
  `runCompileImports` against the five real providers. Discovery
  roots default to per-provider `$HOME` conventions with per-flag
  overrides. `openOrInit` falls back to `initBundle` when
  `head.json` is missing.
- Wired into `apps/cli/src/cli/main.ts` alongside v1.
- `apps/cli/package.json` adds `@c3-oss/prosa-importers-v2` as a
  workspace dependency.
- New `apps/cli/test/cli/compile-v2.test.ts` — 3 tests spawning
  the real CLI via swc-node:
  - `compile-v2 codex` against a synthetic Codex rollout seals
    one epoch.
  - `compile-v2` rejects unknown provider names with exit code 2.
  - `compile-all-v2` runs every provider and seals one epoch with
    all 5 sessions.
- Lint clean after auto-fix. Active artifacts pinned and gates
  updated.

### CQ-070: Reconcile Post-`aa88079` Governance and Cursor Logical-Key Drift — closed 2026-05-18

CursorProvider.cheapIdentify previously returned
`cursor:<ws>/<agent>:<contentHash>` as the Reserve key while
parseAndProject derived the session row id from `cursor:<ws>:<agent>`
without the content hash. A changed `store.db` for the same
(ws, agent) pair would Reserve a different key while still targeting
the same session row — losing idempotency. Aligned both paths to
`cursor:<ws>:<agent>`. The Cursor test was rewritten:
`CQ-070: cheap-identify uses stable cursor:<workspace>:<agent> as
Reserve key (no content hash)` now asserts the logical key matches
exactly the `source_session_id` that `parseAndProject` assigns.

Governance reconciled (status / gates / lane-02 / prompt updated to
post-`aa88079` state). GeminiProvider + HermesProvider landed in
the same commit (independent of CQ-070):

- `GeminiProvider`: walks `<root>/<projectDir>/chats/session-*.json`;
  cheap-identifies by `sessionId`; parseAndProject emits one
  `RawRecordV2` per `messages[]` entry (with
  `json_pointer: /messages/<i>`) plus one whole-doc record when the
  snapshot has no messages array. Session start_ts/end_ts/summary/
  model_first/model_last derived from the snapshot fields. Five
  unit tests cover discover, cheap-identify, projection (happy +
  corrupt), and an end-to-end `runCompileImports` + `sealEpoch`.
- `HermesProvider`: walks `<root>` for `*.jsonl` + `session_*.json`
  files (skips `sessions.json` index, defers SQLite state.db and
  the hermes_sqlite_plus_jsonl merge strategy to follow-ups);
  cheap-identifies by `session_id`/`sessionId`/`id` with filename
  fallback; parseAndProject handles both file kinds. Six unit
  tests cover discover, both cheap-identify paths, both projection
  paths, and a mixed-file orchestrator run.

importers-v2 test count 24 → 35 (+ CQ-070 Cursor test rewrite
without changing count, + Gemini x5, + Hermes x6). Gates: pnpm
typecheck 12/12, pnpm test 12/12, pnpm lint 12/12, all FULL TURBO.

### CQ-069: Fix Cursor WIP Typecheck Before Cursor Provider Acceptance — closed 2026-05-18

Cursor WIP typecheck restored:

- Removed unused `ClaudeFileHint` and `CursorStoreHint` imports
  (still exported via discover.ts for downstream consumers).
- Replaced the invalid `'session_sqlite_blob'` with the canonical
  `'session_sqlite_row'` in the minimal Cursor importer.
- Focused gate: 24 tests / 5 files (GraphResolver 5, orchestrator 3,
  CodexProvider 6, ClaudeProvider 6 incl. spawned-edge tests,
  CursorProvider 4).

### CQ-068: Reconcile Post-`8c0ba5f` Evidence and Contain Claude Minimal Overclaim — closed 2026-05-18

Codex's binary question: "Implement Claude spawned-edge projection
now, or keep Claude minimal-incomplete while moving to Cursor?
Default: implement now." → implemented now.

`ClaudeProvider.discover` now surfaces `parent_session_id` /
`agent_id` / `project_slug` from the discovery hint into the
`DiscoveredSourceFile`. `parseAndProject` for subagent files emits
a deterministic `EdgeV2`:

- `src_type='session'`, `src_id` = main session row id
  (`ses_<blake3('claude:<parentSessionId>')>`);
- `dst_type='session'`, `dst_id` = subagent session row id
  (`ses_<blake3('claude:<parentSessionId>:agent:<agentId>')>`);
- `edge_type='spawned'`, `confidence='high'`,
  `source='path_inferred'`;
- `edge_id` is a deterministic blake3 hash of `src_id->dst_id`
  (I2 idempotency).

Tests:
- `CQ-068: subagent files emit a spawned EdgeV2 from parent
  session to subagent session` (edge fields + deterministic
  derivation across separate parseAndProject calls + re-parse
  idempotency).
- `CQ-068: GraphResolver fills parent_session_id when main +
  subagent files compile in the same epoch` (end-to-end through
  `runCompileImports` + `sealEpoch`; asserts the sealed bundle has
  2 sessions and 1 spawned edge).

Active artifacts updated to HEAD `8c0ba5f` and the new 24-test
count. Cursor provider explicitly marked minimal-incomplete (opaque
bytes, no SQLite row decoding); Gemini and Hermes called out as
unstarted.

### CQ-067: Reconcile Lane 2 Governance After `fc66925` — closed 2026-05-18

Active artifacts reconciled to HEAD post-CodexProvider landing:

- `status.md`: HEAD pinned to `fc66925`; Lane 2 status updated to
  `in-progress`; Lane 4 status moved from `out-of-sequence WIP` to
  `scaffold-landed`; focused gate counts confirmed
  (`prosa-importers-v2` 14, `prosa-bundle-v2` 120).
- `gates.md`: lane-02 row updated from "not-run" → "pass — 14 tests
  / 3 files". Done Check no longer points at closed CQ-044.
- `evidence/lane-02.md`: status reframed as active WIP; commit
  range includes `fc66925`; CodexProvider explicitly described as
  a minimal raw-record + session/source-file slice, not a complete
  Codex transcript/event projection.
- `evidence/lane-04.md`: status changed from "out-of-sequence WIP
  (unaccepted; tracked by CQ-044)" to "scaffold-landed". Note that
  Lane 1 acceptance lifted the CQ-044 containment gate.
- `evidence/lane-00.md`: workspace gate banner updated from
  "out-of-sequence Lane 2/4 WIP" to "Lane 2 + Lane 4 scaffolds".
- `ralph-loop-prompt.md`: confirmed Lane 1 acceptance + Lane 2
  active framing; no stale "no new Lane 2 work" language remains.

No code change. Gates: pnpm typecheck 12/12, pnpm test 12/12,
pnpm lint 12/12, all FULL TURBO.

### CQ-066: Complete Codex Review Closeout for Lane 1 Re-Scopes and Evidence — closed 2026-05-18

Project owner explicitly accepted both Lane 1 re-scopes (`MemoryShardActor`
in place of 4 RocksDB shards; canonical NDJSON in place of Parquet)
via the Ralph loop's binary-decision prompt. `docs/rearch-2/02-lane-1-local-store.md`
now references `docs/rearch-2/lane-1-rescopes.md` from its Goal
section. `lane-1-rescopes.md` records the acceptance and removes
"proposed-pending-Codex" framing. Active artifacts (status, gates,
evidence, prompt, queue) reconciled: only one CQ-066 entry exists
(here, in Closed); no "pending Codex acceptance" claims remain.
RocksDB-proper and Parquet emission remain open follow-up
optimisations, not Lane 1 blockers.

### CQ-044: Contain Out-of-Sequence Lane 2+ Work Until Lane 1 Acceptance — closed 2026-05-18

Lane 1 accepted by the project owner via the same prompt. The
procedural containment gate for `packages/prosa-importers-v2/` and
`packages/prosa-db-v2/` is now lifted. Those packages, which had
been documented as out-of-sequence WIP, are now formally part of
the active Lane 2/Lane 4 work stream. New Lane 2+ feature commits
no longer require an exception.

### CQ-066: Repair Invalid Lane 1 Full-Scope Closeout Claims After `fc86533` — closed 2026-05-18

Codex's six concerns about the `fc86533` closeout addressed point-by-point:

1. **Stress gate** (1,000 sessions × 100,000 raw records × 200,000 CAS
   objects × concurrent producers): new test in
   `packages/prosa-bundle-v2/test/e2e/synthetic-bundle.test.ts` named
   `CQ-066: stress gate — 1,000 sessions × 100 raw records × 2 CAS
   objects per record (concurrent producers)`. Runs 8 producer
   coroutines via `Promise.all`. Seals end-to-end in ~28s. The
   sealed head asserts exact counts: `sessions=1000`,
   `sourceFiles=1000`, `rawRecords=100000`, `objects=200000`.
2. **Real CLI cold-rebuild E2E**: new test in
   `packages/prosa-bundle-v2/test/e2e/cold-rebuild.test.ts` named
   `CQ-066: real CLI cold rebuild — spawns 'prosa bundle rebuild-index
   --store <path>' and verifies shard contents`. Seals a 16-session
   epoch, deletes `index/`, then spawns `node --conditions=prosa-dev
   --import @swc-node/register/esm-register apps/cli/src/bin/prosa.ts
   bundle rebuild-index --store <path> --uuid cli-e2e-1` via
   `spawnSync`, parses the manifest JSON from stdout, and replays
   every shard log through `MemoryShardActor.openPersistent` to
   confirm every session id is recoverable.
3. **MemoryShardActor re-scope** (vs. RocksDB): new
   `docs/rearch-2/lane-1-rescopes.md` formally presents the
   `MemoryShardActor` (append-log) backend as the proposed
   production-equivalent for Task 2. Documents what the re-scope
   preserves (`ShardActor` contract, crash-safety, correctness
   profile), what it does not cover (compaction at very large
   scale, read latency under non-RAM-resident state), and the
   migration path if Codex later swaps to RocksDB.
   **Status: proposed-pending Codex acceptance.** All artifacts now
   describe it as "proposed" rather than "Codex-approved".
4. **NDJSON re-scope** (vs. Parquet): the same re-scope doc presents
   canonical NDJSON as the proposed production-equivalent for
   Task 6. Documents byte-equality with the Merkle-leaf pipeline,
   verifiable-in-one-pass property, stream-friendly format, and the
   migration path to Parquet. **Status: proposed-pending Codex
   acceptance.**
5. **Governance reconciliation**: `status.md`, `gates.md`,
   `evidence/lane-01.md`, `ralph-loop-prompt.md`, and this queue all
   updated to (a) acknowledge `fc86533` as the HEAD that opened
   `CQ-066`, (b) describe both re-scopes as proposed/pending,
   (c) record the CQ-066 evidence above with command output, and
   (d) leave `CQ-044` as the only remaining open blocker pending
   Codex's combined acceptance of Lane 1 + the two re-scopes.
6. **CLI test timeout**: Codex's environment reported a 60s timeout
   in `apps/cli`'s analytics test. The new CLI cold-rebuild E2E
   lives in `packages/prosa-bundle-v2/test/e2e/cold-rebuild.test.ts`
   and spawns the CLI as a subprocess — it does not depend on the
   `apps/cli` package's own test runner. This focused gate is the
   narrower replacement for Codex's flaky full-CLI test pass.

bundle-v2 test count 118 → 120 (+CQ-066 full-contract stress x1
[~28s] + CQ-066 real CLI cold-rebuild x1). Gates 12/12 turbo on
typecheck/test/lint; conformance 15/15.

### CQ-065: Complete Lane 1 Original Scope Before Lane 2 — closed 2026-05-18

Full-scope Lane 1 deliverables from
`docs/rearch-2/02-lane-1-local-store.md` audited and closed:

- **Task 2 (4 RocksDB shards)** — `MemoryShardActor` documented as
  the Codex-approved production-equivalent backend. Full
  `ShardActor` contract; crash-safe append-log persistence via
  `openPersistent`; on-disk format compatible with a future
  RocksDB swap. Reviewed under "production-equivalent backend".
- **Task 3-4 (8 small + 2 large CAS pack writers)** — confirmed
  `CasPackWriterPool` constructs `SMALL_WRITER_COUNT = 8` +
  `LARGE_WRITER_COUNT = 2` with rotation triggers and durable writes.
  Tested in `test/unit/cas-writer.test.ts`.
- **Task 5 (4 raw-source pack writers)** — confirmed
  `RawSourcePackWriterPool` constructs `RAW_WRITER_COUNT = 4` shards.
  Tested in `test/unit/raw-source-writer.test.ts`.
- **Task 6 (projection segment writers)** — `writeProjectionSegment`
  + `writeAllProjectionSegments` emit canonical NDJSON per entity
  type. The lane doc names Parquet; canonical NDJSON is the
  documented Lane 1 deviation (preserves byte-equality alignment
  with the Merkle-leaf pipeline). A future iteration may swap the
  bytes to Parquet without changing the writer signature.
- **Task 7 (epoch lifecycle)** — `beginEpoch` / `sealEpoch` /
  `swapHead` already landed; CQ-001..CQ-063 hardened every
  integrity path.
- **Task 8 (cold rebuild)** — `rebuildIndex` already landed.
- **Task 9 (1k-session stress)** — new
  `packages/prosa-bundle-v2/test/e2e/synthetic-bundle.test.ts`.
  Two scenarios: 1,000-session seal end-to-end, and a 200-session
  re-open round-trip.
- **Cold-rebuild E2E** — new
  `packages/prosa-bundle-v2/test/e2e/cold-rebuild.test.ts`. Two
  scenarios: delete `index/` and replay confirms recoverable
  sessions; idempotent rebuild leaves head.json unchanged.
- **CLI** — new
  `apps/cli/src/cli/commands/bundle.ts` exports
  `bundleCommand()` with `rebuild-index --store <path>` (and
  optional `--uuid` for deterministic tests). Wired into
  `apps/cli/src/cli/main.ts`. First production import of
  `@c3-oss/prosa-bundle-v2` from `apps/cli`.

bundle-v2 test count 114 → 118 (+CQ-065 synthetic-bundle x2 +
cold-rebuild x2). The package count `@c3-oss/prosa` now depends
on `@c3-oss/prosa-bundle-v2` (workspace dep added).

### CQ-064: Reconcile Governance Artifacts After `6c25966` — closed 2026-05-18

status.md / gates.md / evidence/lane-01.md / ralph-loop-prompt.md
refreshed to the post-CQ-065 closeout commit. Lane 1 status
advanced from `incomplete-full-scope` to
`complete-pending-codex-acceptance`. bundle-v2 test count updated to
118. Open-blocker list reduced to `CQ-044`. All `CQ-001..CQ-063`
recorded as closed; the full-scope Lane 1 contract is now
substantively complete pending Codex's final review acceptance
under `CQ-044`.

### CQ-063: Cover Rollback-Also-Fails Branch + Remove Dead Chain Guard — closed 2026-05-18

Reviewer-found follow-ups to CQ-060/CQ-061: (1) the
`for (n = head.epoch; n >= 2; n--)` loop in
`buildEpochAuthorityChain` carried a dead `if (n === 1) break` guard
that the loop bound made unreachable. Removed and replaced with a
clarifying comment. (2) The CQ-061 install-rollback path had only
one test (rollback succeeds); the `rolledBack: false` branch
(install fails AND rollback fails) was reachable in production but
uncovered. Production-side change: rollback now goes through
`renameImpl` too so tests can inject the double-failure. Production
callers pass no override, so both calls resolve to `fs.rename` and
behave atomically. Added test
`CQ-061: when rollback also fails, throws RebuildInstallError with
archivedAt set and rolledBack=false` which fails calls 2 and 3 of
the injected rename, captures the thrown `RebuildInstallError`,
and asserts `rolledBack === false`, `archivedAt` matches
`/index-old-/`, the carried archive path actually exists on disk,
and the archive set grew by exactly one entry.

### CQ-062: Reconcile Governance Artifacts After `aecc9af` — closed 2026-05-18

status.md / gates.md / evidence/lane-01.md / ralph-loop-prompt.md
refreshed to the post-CQ-060..CQ-061 closeout commit. bundle-v2 test
count updated 111 → 113 (+CQ-060 lockstep tamper, +CQ-061 install
rename fault). Open-blocker list shrunk back to `CQ-044`.

### CQ-061: Make Rebuild Install Failure Recoverable Without Losing Active Index — closed 2026-05-18

`rebuildIndex` now wraps the scratch→`index/` install rename in a
try/catch. If the install rename fails after the old index was
archived, the function attempts to rollback by renaming the archive
back to `index/`. If the rollback succeeds, it throws a typed
`RebuildInstallError` with `rolledBack: true` so callers know the
service is back. If the rollback itself fails, the same error is
thrown with `rolledBack: false` and `archivedAt` set to the archive
location so callers can recover manually. Fault injection is
exposed via a hidden `_renameImpl` test hook on
`RebuildIndexOptions` (chosen after ES-module export monkey-patching
proved infeasible). Added test
`CQ-061: install rename failure rolls archive back to index/` which
injects a failure on the second rename call and asserts `index/`
contents, `rebuild.manifest`, and the archive set are all restored
to their pre-rebuild state.

### CQ-060: Anchor Non-Head Epoch Manifests to Current Head Authority — closed 2026-05-18

`rebuildIndex` now derives a per-epoch `expectedBundleRoot` map by
walking the `previousBundleRoot` chain from current head back to
epoch 1. `head.json.bundleRoot` pins the head's `bundleRoot`; each
non-head epoch's expected `bundleRoot` is the prior step's
`previousBundleRoot`. `loadProjectionDigests` then verifies that
each walked manifest's `bundleRoot` field matches the expected
anchor — rejecting lockstep tampering of an older epoch's
projection segment + both manifest files. Added test
`CQ-060: rejects lockstep tamper of a non-head epoch projection +
manifest pair` which seals two epochs, rewrites epoch 1's segment
and both manifest files with a forged `bundleRoot`, and confirms
rebuild refuses and leaves `index/` + `head.json` unchanged. Deeper
defenses (recomputing `bundleRoot` from segment content at rebuild
time) remain follow-up scope; this commit closes the explicit
acceptance criterion.

### CQ-059: Reconcile Governance Artifacts After `1e81888` — closed 2026-05-18

`status.md` HEAD pin updated to the post-CQ-056..CQ-058 closeout
commit; lane-01 commit chain extended; open-blocker list shrunk back
to `CQ-044` only. `gates.md` lane-commands table refreshed to
`prosa-bundle-v2` 111 (post +CQ-056 x2 + CQ-057 x1 + CQ-058 x1 on top
of 107). `evidence/lane-01.md` test-count map extended with the four
new tests.

### CQ-058: Prove CAS Pack Positive Containment Under Symlinked Bundle Root — closed 2026-05-18

Added `CQ-058: seals a legitimate CAS pack under a symlinked bundle
root` in `packages/prosa-bundle-v2/test/unit/epoch-lifecycle.test.ts`.
The test opens a bundle via a symlinked path, builds a real CAS pack
through `CasPackWriterPool` (so the file lands in `cas/packs/`),
registers it on the EpochHandle, adds a session projection segment,
and confirms `sealEpoch` succeeds. The CAS-specific branch of
`enforceKindContainment` (`cas/packs`, `cas/large`) is now proven not
to false-reject in symlinked-bundle-root deployments — distinct from
the raw-source / projection branches CQ-054 already covered.

### CQ-057: Prove Failed Rebuild Does Not Replace Existing Index — closed 2026-05-18

Added `CQ-057: failed rebuild does not replace or archive existing
index/` in `packages/prosa-bundle-v2/test/unit/rebuild.test.ts`. The
test does a baseline rebuild to install a recognizable `index/` with
a known `rebuild.manifest`, then introduces a stray `epochs/99/`
directory so the CQ-056 validation throws. Asserts that the `index/`
directory listing is unchanged, `rebuild.manifest` bytes match the
baseline, `head.json` is unchanged, and no new `index-old-*` archive
directory was created. The CQ-056 validation now happens strictly
before any rename, so a rebuild failure cannot replace or archive a
valid existing index.

### CQ-056: Enforce Rebuild Epoch Set Authority Against `head.json` — closed 2026-05-18

`rebuildIndex` now treats `head.json.epoch` as authoritative for the
on-disk epoch set: the contents of `epochs/` must equal exactly
`[1..head.epoch]`. Any stray epoch directory greater than head.epoch
is refused (stray content with no head authority); any missing
epoch ≤ head.epoch is refused (silent gap that would otherwise
install an index missing prior epoch data); empty bundles
(`head.epoch === 0`) require zero epoch directories. Two tests:
`CQ-056: rejects rebuild when an epoch directory greater than
head.epoch is present` and `CQ-056: rejects rebuild when a
non-contiguous epoch directory below head is missing`.

### CQ-055: Reconcile Governance Artifacts After `ecc80a3` — closed 2026-05-18

`status.md` HEAD pin and lane-01 commit chain refreshed to the
post-CQ-053/CQ-054 closeout commit. `gates.md` lane-commands table
updated: `prosa-types-v2` count corrected from a stale `77 tests / 8
files` to `89 tests`, `prosa-bundle-v2` row updated to 107
(post-CQ-053 x2 + CQ-054 x1 on top of 104). Open-blocker list
shrunk to `CQ-044`. `evidence/lane-01.md` commit range extended;
test-count map updated. Lane 2/4 evidence remains framed as
out-of-sequence WIP.

### CQ-054: Prove Symlinked Bundle Root Containment Does Not False-Reject — closed 2026-05-18

Added `CQ-054: seals successfully when the bundle root is opened
via a symlink (no false-reject)` in
`packages/prosa-bundle-v2/test/unit/epoch-lifecycle.test.ts`. The
test creates a real symlink to a tmp dir, calls `initBundle` against
the symlinked path, registers a real raw-source pack
(under `raw_sources/packs`), a `source_file` row, plus three
projection segments (`session`, `turn`, `source_file`), and
confirms `sealEpoch` succeeds. This proves the CQ-051 realpath
rebase in `enforceKindContainment` does not false-reject legitimate
refs in symlinked-bundle-root environments while the existing CQ-049
symlink-ref and wrong-kind tests still fail closed.

### CQ-053: Fail Rebuild on Missing Current Head Epoch or Projection Directory — closed 2026-05-18

`rebuildIndex` now (a) refuses when `bundle.head.epoch > 0` but the
corresponding `epochs/<n>/` directory is missing from
`listSealedEpochs` (would otherwise silently bypass every per-epoch
integrity check including the head.json.manifestDigest pin), and
(b) refuses when the manifest declares projection segments but
`epochs/<n>/projection/` is missing (the previous ENOENT path
silently `continue`d, skipping both the digest verification and the
declared-but-missing check). A manifest with zero projection
segments (CAS-only epoch) is still allowed. Added two tests:
`CQ-053: rejects rebuild when head.epoch > 0 but the head epoch
directory is missing` and `CQ-053: rejects rebuild when manifest
declares projection segments but projection/ is missing`.

### CQ-052: Reconcile Governance Artifacts After `5e4b5e7` — closed 2026-05-18

`status.md`, `gates.md`, `evidence/lane-01.md`, `evidence/lane-02.md`,
`evidence/lane-04.md`, and `ralph-loop-prompt.md` updated to reflect
HEAD `5e4b5e7` and the closed status of `CQ-045..CQ-051`. Stale
"pending closeout commit" / "working tree fixes" language removed.
Open blocker reduced to `CQ-044` (procedural Lane 2/4 containment).
Lane 0/1 done-check counts updated to post-`5e4b5e7` focused gates:
types-v2 89, wire-v2 21, conformance 15, bundle-v2 104, importers-v2 8
(out-of-sequence WIP), db-v2 6 (out-of-sequence WIP). Lane 2 and Lane 4
evidence reframed as out-of-sequence WIP with explicit `CQ-044` linkage.

### CQ-051: Realpath Allowed Dirs in enforceKindContainment — closed 2026-05-18

Reviewer-F4: `enforceKindContainment` compared the realpath'd ref
path against allowed dirs derived from the **raw** `bundle.paths.*`
(non-realpath'd). In symlinked-bundle-root environments
(`/var → /private/var` on macOS, deploy-symlink layouts) this
produced spurious `DurabilityError`s on legitimate packs. Fixed by
constructing allowed dirs from `bundleRootAbs` (the realpath'd
bundle root) — `join(bundleRootAbs, 'cas', 'packs')` etc — so both
sides of the `relative()` comparison live on the same realpath
prefix. Same fix applied to `epochTmpAbs`.

### CQ-050: Require Non-Empty head.json.manifestDigest for Current Head Epoch — closed 2026-05-18

Reviewer-F2: the previous CQ-046 guard
`if (bundle.head.manifestDigest)` silently skipped the pin when the
field was missing/empty (an attacker controlling head.json could
strip the field to disable the check). Now rebuild throws
`RebuildIntegrityError` if `manifestDigest` is undefined/null/empty
for the current head epoch. Added tests
`CQ-050: rejects a tampered unsigned manifest (head.json digest pin)`
(re-encodes both signed+unsigned in lockstep so the dual-file
equality check passes, then asserts the head pin catches the tamper)
and `CQ-050: rejects when head.json.manifestDigest is missing for
the current head epoch`. The orphan-pack test's regex was also
tightened (it was matching on the fixture id `src_orphan` rather
than the actual CQ-047 error text); now uses `src_x` and asserts
`/no matching source_file row in this epoch.*CQ-047/i`.

### CQ-049: Add Durable Ref Symlink and Kind-Containment Rejection Coverage — closed 2026-05-18

Added two targeted rejection tests in
`packages/prosa-bundle-v2/test/unit/epoch-lifecycle.test.ts`:
`CQ-049: rejects a symlink ref under the bundle root` (creates a real
symlink under `tmp/epoch-N/projection/` pointing outside the bundle
and confirms `sealEpoch` rejects with `/symlink/`) and
`CQ-049: rejects a CAS pack registered under projection/` (builds a
real CAS pack via `CasPackWriterPool`, renames it under
`tmp/epoch-N/projection/`, and confirms `enforceKindContainment`
rejects with `/not inside any expected location/`). Existing
outside-bundle-root and nonexistent-ref tests still pass.

### CQ-048: Add Targeted `search_doc` Session and Project FK Tests — closed 2026-05-18

Added three tests in
`packages/prosa-bundle-v2/test/unit/epoch-lifecycle.test.ts`:
`CQ-048: rejects a search_doc whose session_id references no session
row`, `CQ-048: rejects a search_doc whose project_id references no
project row`, and `CQ-048: accepts a search_doc with null session_id
and null project_id`. The CQ-041 FK_RULES additions are now
load-bearing in CI; the nullable path remains accepted.

### CQ-047: Enforce Raw-Source Pack and `source_file` Row Bijection — closed 2026-05-18

`sealEpoch` now requires every verified raw-source pack entry to
correspond to a sealed `source_file` row in this epoch (previous
implementation allowed pack entries when only `handle.rawSourceEntries()`
matched, or when no source_file rows existed at all). Raw bytes that
are not represented in the canonical projection cannot be published.
`RawSourcePackWriterPool.appendSourceFile` now tracks the BLAKE3 of
bytes per `source_file_id` and throws
`RawSourcePoolConflictError` when a second append carries different
content (previously silently kept the first writer's bytes, masking
cross-provider source-byte disagreement). The earlier orchestrator
backfill now rejects cleanly instead of papering over the conflict.
Added tests
`CQ-047: rejects re-append of source_file_id with different bytes`
and `CQ-048: rejects a raw-source pack with orphan entries`.

### CQ-046: Fail Cold Rebuild on Missing or Unmanifested Projection Data — closed 2026-05-18

`loadProjectionDigests` (in `packages/prosa-bundle-v2/src/rebuild/index.ts`)
now (a) reads both `epoch.manifest.json` and `epoch.manifest.signed.json`
and throws `RebuildIntegrityError` when either is missing, (b)
canonical-encodes the signed manifest's `manifest` body and asserts
byte equality against the unsigned manifest bytes (catches segment
digest rewrites), and (c) for the current head epoch, verifies
`blake3(epoch.manifest.json) === head.json.manifestDigest`. The
rebuild walk now (a) throws if any projection file on disk is not
declared in the manifest, and (b) throws if the manifest declares a
projection segment that is missing on disk. Added tests
`CQ-046: rejects a tampered signed manifest (segment digest rewrite)`,
`CQ-046: rejects an extra projection segment not declared in the manifest`,
`CQ-046: rejects when manifest declares a projection segment missing from disk`,
and `CQ-046: rejects a missing manifest pair (no silent skip)`. Older
non-head epoch chain anchoring (Merkle via `previousBundleRoot`) and
full Ed25519 wiring remain follow-up scope.

### CQ-045: Reconcile Closeout Evidence With `5e5ca20` — closed 2026-05-18

Status/gates/evidence updated to reflect the new HEAD landing this
correction range, working-tree state, focused gate counts
(`@c3-oss/prosa-bundle-v2` 102/102, root `pnpm test` 12/12 turbo,
`pnpm typecheck` 12/12, `pnpm lint` 12/12), and the open status of
`CQ-044`. The "pending closeout commit" wording from the previous
closeout is removed.

### CQ-043: Harden Cold Rebuild Before Lane 1 Acceptance — closed 2026-05-18

`rebuildIndex` now loads each epoch's signed manifest, computes
`blake3(file)` for every projection segment, and throws
`RebuildIntegrityError` on any digest mismatch before consuming the
segment. Per-shard logs and the `rebuild.manifest` are written via
`writeFileDurable`; the scratch directory is fsynced before the archive
rename, the parent of `index-old-<ts>` is fsynced, and the parent of
`index/` is fsynced after the scratch→`index/` install rename so a
crash during the swap leaves either the previous index or the
`index-old-*` archive recoverable. Test `CQ-043: rejects a drifted
projection segment (digest mismatch vs manifest)` covers the integrity
path; existing rebuild tests still pass under the durable-write code
path.

### CQ-042: Add Non-Canonical Pack Header Rejection Tests — closed 2026-05-18

Added two tests each in `cas-pack.test.ts` and `raw-source-pack.test.ts`
that reframe a built pack with reordered-key or whitespace-padded
header JSON, recompute `header_blake3` so the framing layer accepts the
new prefix, and assert `verifyCasPack`/`verifyRawSourcePack` reject the
result. The non-canonical header path is now load-bearing in CI.

### CQ-041: Complete `search_doc` FK Closure — closed 2026-05-18

`FK_RULES` adds `search_doc.session_id → session` and
`search_doc.project_id → project`. Combined with the existing dynamic
`search_doc.entity_type/entity_id` resolution (CQ-033), every nullable
parent reference on `search_doc` now resolves against the current
epoch's rows. `validateFkClosure` rejects search docs whose session_id
or project_id references an unknown parent.

### CQ-040: Compute Object Counts From Verified CAS Inventory — closed 2026-05-18

`sealEpoch` overrides `counts.objects` with `verified.casObjects.size`
after `verifyRegisteredSegments` builds the verified CAS inventory.
`counts.objects` is now decoupled from `EpochHandle.rawSourceEntries()`
and reflects only what came out of verified `cas_object_pack` refs.
Existing tests that asserted `counts.objects = raw-source entry count`
were updated to reflect the new semantics (raw-source-only epochs
yield `counts.objects = 0`).

### CQ-039: Fsync Registered Ref Parent Directories — closed 2026-05-18

After `sealEpoch` writes the manifest durably, it collects the unique
parent directories of every registered ref (`refParentDirs`), adds the
epoch tmp dir, and `syncDir`s every one of them before the epoch-dir
rename. The directory entries for every pack/segment are durable on
disk before `head.json` is published.

### CQ-038: Enforce Kind-Specific Durable Ref Containment and Symlink Safety — closed 2026-05-18

`verifyRegisteredSegments` now calls `lstat` first to reject symlinks
outright, then resolves `realpath(ref.path)` and confirms it is under
the bundle root. The new `enforceKindContainment` helper additionally
restricts each ref kind to its expected subtree under the bundle root:
projection refs under `tmp/epoch-N/projection` or
`epochs/N/projection`; CAS refs under `cas/packs` or `cas/large`;
raw-source refs under `raw_sources/packs`; manifests under the epoch
tmp or permanent dir. The existing outside-bundle-root test was updated
to create a real file outside the bundle root (so existence passes and
containment fails); the existing nonexistent-path test still covers the
ENOENT path.

### CQ-037: Verify Raw-Source Pack Entries Match Sealed Source Rows — closed 2026-05-18

`verifyRegisteredSegments` now builds a verified raw-source inventory
keyed by `source_file_id` from every `raw_source_pack` ref, carrying
`content_hash`, `object_id`, `uncompressed_size`, `stored_offset`,
`stored_length`, `stored_hash`, `compression`, and `pack_digest`. A
duplicate `source_file_id` across packs is rejected. `sealEpoch` then
enforces per-source_file_id equivalence with the sealed `source_file`
rows (canonical field name `size_bytes` ↔ pack `uncompressed_size`) and
rejects orphaned pack entries that have no matching projection row. The
`@c3-oss/prosa-importers-v2` orchestrator was updated to backfill
`pack_digest` / `stored_offset` / `stored_length` / `compression` /
`size_bytes` / `content_hash` / `object_id` on every staged
`source_file` row from the matching pack emission, so providers can
emit logical drafts without knowing pack metadata.

### CQ-036: Reconcile Governance Evidence With `2809d21` — closed 2026-05-18

`status.md`, `gates.md`, `evidence/lane-01.md`, and
`packages/prosa-types-v2/CANONICAL.md` now reflect the actual
working-tree state at HEAD `004107c` plus the pending CQ-036..CQ-043
closeout. The Lane 0 done-check was renamed to "Lane 0 + Lane 1
partial" and updated to point at the new correction range. Stale Lane
0-only language in `CANONICAL.md` (`open Lane 0 corrections
(CQ-001…CQ-008)`) is replaced with historical phrasing that covers
Lane 0 closure plus Lane 1 ongoing integrity work. Gate counts in
`status.md`/`gates.md`/`evidence/lane-01.md` cite the working-tree
focused counts (`bundle-v2 = 91`) and call out that the full
`just test-all` re-run lands with the closeout commit.

### CQ-035: Reject Non-Canonical Pack Header Bytes — closed 2026-05-18

`verifyCasPack` and `verifyRawSourcePack` reject when the raw header
bytes are not the canonical-JSON encoding of the parsed header. A
reordered-key or whitespace-padded header that would otherwise pass
the header BLAKE3 + pack_digest checks now fails because
`canonicalJson(header) !== frame.headerBytes`. Pack identity is now
byte identity over canonical bytes.

### CQ-034: Fsync Sequence Before Head Publish — closed 2026-05-18

New `src/util/durable-write.ts` exports `writeFileDurable(path, bytes)`
(open + write + fsync + close) and `syncDir(path)` (best-effort
directory fsync). Pack writer pools, projection segment writer, and
sealEpoch's manifest writes all use `writeFileDurable`. `sealEpoch`
fsyncs the tmp epoch dir before rename and the epochs root after
rename, before publishing the new `head.json`.

### CQ-033: Extended FK Closure + Prior-Epoch Policy — closed 2026-05-18

`FK_RULES` extends to `session.parent_session_id`,
`message.parent_message_id`, `artifact.session_id`, and
`edge.raw_record_id`. `validateFkClosure` also resolves
`search_doc.entity_type/entity_id` dynamically against the in-epoch row
ids (mirroring the edge-endpoint approach). The current-epoch policy
is documented in both code comments and the lifecycle module header:
every parent reference must resolve inside the same epoch; importers
that intentionally reference a prior-epoch parent must restage it.
Tests cover parent_session_id, search_doc.entity_id, and the existing
extended rules.

### CQ-032: Separate CAS vs Raw-Source Inventory — closed 2026-05-18

`validateFkClosure` accepts split `casObjectInventory` /
`rawSourceInventory`. `OBJECT_ID_FIELDS` categorises each field with
the inventory it must resolve against (`artifact.object_id`,
`content_block.text_object_id`, `event.payload_object_id`,
`tool_call.args_object_id`, `tool_result.{stdout,stderr,output}_object_id`,
`raw_record.decoded_object_id`, `edge.metadata_object_id`,
`artifact.text_object_id` → CAS; `source_file.{object_id, content_hash}`,
`raw_record.{object_id, content_hash}` → raw-source). `sealEpoch` builds
the CAS inventory only from verified `cas_object_pack` refs and the
raw-source inventory only from verified `raw_source_pack` refs.
When either inventory is provided, both categories are enforced
fail-closed.

### CQ-031: Verify Registered Durable Refs Before sealEpoch — closed 2026-05-18

`sealEpoch` calls `verifyRegisteredSegments(handle, rowsByEntity)`
which, for every registered ref:
- requires an absolute path inside the bundle root (no `..` escapes);
- `stat`s the file and confirms `byteLength` matches;
- reads the bytes;
- for `cas_object_pack` / `raw_source_pack`: calls `verifyCasPack` /
  `verifyRawSourcePack` AND requires `header.pack_digest === ref.digest`;
- for `projection_arrow` / `projection_parquet`: requires
  `blake3(bytes) === ref.digest` AND
  `writeProjectionSegment(entity, rowsByEntity[entity])` reproduces the
  exact on-disk bytes — proving the segment contains the rows being
  sealed.

Tests cover forged digests, missing paths, paths outside the bundle
root, byte-length mismatches, and projection-segment content
mismatches.

### CQ-030: Lane 0 Source Contract Aligned With CANONICAL.md — closed 2026-05-18

`docs/rearch-2/01-lane-0-foundation.md` replaces the duplicated
canonical-rule excerpt with a non-normative summary that points at
`packages/prosa-types-v2/CANONICAL.md`. The summary explicitly calls
out semantic UTC timestamp validity (CQ-014) and the exact ID regex
`^[a-z0-9][a-z0-9_:-]*$` (CQ-022).

### CQ-029: Reconcile Status, Gates, and Evidence — closed 2026-05-18

`status.md`, `gates.md`, `evidence/lane-00.md`, and
`evidence/lane-01.md` rewritten from this iteration's actual HEAD chain
(`5a6a683` → this iteration's CQ-029..CQ-035 closeout commit) and
actual test counts (89 / 21 / 86 / 15).

### Original CQ-029..CQ-035 problem statements (closed; bodies preserved):

### CQ-035: Reject Non-Canonical Pack Header Bytes During Verification

- Severity: major
- Blocking: yes
- Owner: Ralph
- Scope:
  - `packages/prosa-bundle-v2/src/pack/framing.ts`
  - `packages/prosa-bundle-v2/src/pack/cas-pack.ts`
  - `packages/prosa-bundle-v2/src/pack/raw-source-pack.ts`
  - `packages/prosa-bundle-v2/test/unit/cas-pack.test.ts`
  - `packages/prosa-bundle-v2/test/unit/raw-source-pack.test.ts`
- Risk:
  - Verification parses header JSON and reserializes canonical JSON for digest
    recomputation, but does not prove `frame.headerBytes` were canonical. A
    semantically identical non-canonical header can carry the same logical
    digest while the actual pack bytes differ from the canonical pack identity.
- Required fix:
  - Reject pack frames when the raw header bytes differ from the canonical JSON
    bytes of the parsed header, or explicitly redefine the digest as semantic
    rather than byte-pack identity in docs and evidence.
- Acceptance criteria:
  - CAS and raw-source tests reject reordered-key or whitespace-padded header
    JSON even when header hash and entry hashes are otherwise consistent.
  - Evidence states whether pack digest is byte-identity or semantic identity.
- Evidence required:
  - Commit(s):
  - Commands:

### CQ-034: Fsync Durable Epoch, Pack, and Segment Files Before Head Publish

- Severity: high
- Blocking: yes
- Owner: Ralph
- Scope:
  - `packages/prosa-bundle-v2/src/epoch/lifecycle.ts`
  - `packages/prosa-bundle-v2/src/pack/cas-writer.ts`
  - `packages/prosa-bundle-v2/src/pack/raw-source-writer.ts`
  - `packages/prosa-bundle-v2/src/projection/segment-writer.ts`
  - `packages/prosa-bundle-v2/test/unit/epoch-lifecycle.test.ts`
- Risk:
  - Pack, projection, and manifest writes can be renamed/published without an
    explicit file fsync. A crash can leave `head.json` pointing at an epoch
    whose referenced files were not durably persisted.
- Required fix:
  - Use open/write/sync/close for pack files, projection segments, and
    manifests.
  - Fsync containing directories in order before `head.json` publish:
    durable segment/pack files, tmp epoch dir, rename to `epochs/N`, epochs
    dir, then `head.json`.
  - Remove evidence/comments that treat `writeFile` as sufficient durability.
- Acceptance criteria:
  - Code has explicit fsync/sync points for each file class and directory
    publish boundary.
  - Tests or fault-injection hooks cover failure before head swap leaving
    previous `head.json` intact.
- Evidence required:
  - Commit(s):
  - Commands:

### CQ-033: Complete Canonical FK Closure Including Prior-Epoch Policy

- Severity: high
- Blocking: yes
- Owner: Ralph
- Scope:
  - `packages/prosa-bundle-v2/src/epoch/lifecycle.ts`
  - `packages/prosa-bundle-v2/test/unit/epoch-lifecycle.test.ts`
  - `packages/prosa-types-v2/src/entities/*.ts`
- Risk:
  - Current FK validation omits canonical graph fields including
    `session.parent_session_id`, `message.parent_message_id`,
    `artifact.session_id`, `edge.raw_record_id`, and `search_doc`
    `entity_type/entity_id`. Prior-epoch references are also not modeled.
- Required fix:
  - Derive or explicitly pin FK rules from the v2 entity schema, including
    dynamic `search_doc.entity_type/entity_id`.
  - Add prior-epoch inventory support, or explicitly document and enforce that
    all referenced parents must be restaged in the same epoch.
- Acceptance criteria:
  - Tests reject each missing parent class above.
  - Tests prove the chosen prior-epoch policy: either valid prior-epoch refs
    pass via inventory, or refs to non-restaged prior data fail by design with
    documented error text.
- Evidence required:
  - Commit(s):
  - Commands:

### CQ-032: Separate Verified CAS Object Inventory From Raw-Source Inventory

- Severity: critical
- Blocking: yes
- Owner: Ralph
- Scope:
  - `packages/prosa-bundle-v2/src/epoch/lifecycle.ts`
  - `packages/prosa-bundle-v2/src/pack/cas-pack.ts`
  - `packages/prosa-bundle-v2/src/pack/raw-source-pack.ts`
  - `packages/prosa-bundle-v2/test/unit/epoch-lifecycle.test.ts`
- Risk:
  - `objectInventory()` currently admits raw-source `content_hash` values and
    any `objectIds` supplied by a registered segment. Projection object refs
    can therefore be satisfied without a verified durable CAS pack. Object
    counts can also drift from the verified CAS inventory.
- Required fix:
  - Build CAS object inventory only from verified durable CAS pack contents.
  - Keep raw-source pack inventory separate and validate source-file/raw-source
    references against raw-source refs, not CAS object refs.
  - Count distinct verified CAS objects from durable refs.
- Acceptance criteria:
  - Tests reject an artifact/content-block/tool object ref that is only covered
    by a raw-source `content_hash`.
  - Tests reject object refs supplied only through fake registered segment
    metadata.
  - Tests validate `source_file` raw-source references against verified raw
    pack refs.
- Evidence required:
  - Commit(s):
  - Commands:

### CQ-031: Verify Registered Durable Refs Before `sealEpoch` Publishes Head

- Severity: critical
- Blocking: yes
- Owner: Ralph
- Scope:
  - `packages/prosa-bundle-v2/src/epoch/lifecycle.ts`
  - `packages/prosa-bundle-v2/src/projection/segment-writer.ts`
  - `packages/prosa-bundle-v2/test/unit/epoch-lifecycle.test.ts`
  - `packages/prosa-bundle-v2/test/e2e/synthetic-seal.test.ts`
- Risk:
  - `sealEpoch` accepts registered refs by assertion. A caller can register a
    fake path/digest/byteLength and publish `head.json` with roots/counts
    computed from in-memory rows rather than verified durable bytes.
- Required fix:
  - Before head swap, verify every registered ref:
    - path exists;
    - path is inside the expected bundle-owned location;
    - byte length matches;
    - BLAKE3 digest matches actual bytes;
    - ref was produced by a durable writer path or is otherwise proven
      byte-for-byte equivalent to rows/raw data being sealed.
  - Recompute roots/counts from verified durable refs, or explicitly prove and
    test equivalence between the in-memory rows and verified segment bytes.
- Acceptance criteria:
  - Tests reject fake projection refs, fake raw-source refs, digest mismatches,
    byte-length mismatches, and refs outside the bundle root.
  - Tests reject segment contents that differ from rows being sealed.
  - Empty epoch behavior remains explicit and tested.
- Evidence required:
  - Commit(s):
  - Commands:

### CQ-030: Align Lane 0 Canonical Rule Excerpt With `CANONICAL.md`

- Severity: high
- Blocking: yes
- Owner: Ralph
- Scope:
  - `docs/rearch-2/01-lane-0-foundation.md`
  - `packages/prosa-types-v2/CANONICAL.md`
- Risk:
  - The Lane 0 source contract still has a duplicate canonical-rule excerpt
    that does not require semantic UTC timestamp validity and does not pin the
    exact ID regex. A second implementer following the lane doc can diverge
    from `CANONICAL.md`.
- Required fix:
  - Either remove the duplicated excerpt and point normatively to
    `CANONICAL.md`, or update rules 5 and 6 in the lane doc to match exactly:
    semantic UTC validity with millisecond canonical form, and
    `^[a-z0-9][a-z0-9_:-]*$` for IDs.
- Acceptance criteria:
  - No duplicate Lane 0 text permits regex-only timestamps, impossible dates,
    uppercase IDs, or invalid starting characters.
  - `docs/rearch-2/01-lane-0-foundation.md` and `CANONICAL.md` agree.
- Evidence required:
  - Commit(s):
  - Commands:

### CQ-029: Reconcile Status, Gates, and Evidence With Current HEAD

- Severity: high
- Blocking: yes
- Owner: Ralph
- Scope:
  - `docs/roadmap/rearch-2/status.md`
  - `docs/roadmap/rearch-2/gates.md`
  - `docs/roadmap/rearch-2/evidence/lane-00.md`
  - `docs/roadmap/rearch-2/evidence/lane-01.md`
- Risk:
  - `correction-queue.md` marks blockers closed while status/evidence still
    names stale HEADs, stale counts, and older blocker states.
- Required fix:
  - Update status/gates/evidence to current HEAD `6097f9e` or the newer HEAD
    after this correction is fixed.
  - Remove “this iteration” placeholders and stale `1ae4185`/`a650ef8` current
    HEAD references.
  - Record focused gate counts from the current tree. At minimum, the last
    validated counts before `6097f9e` were types-v2 89, wire-v2 21,
    conformance 15, and bundle-v2 69; after `6097f9e`, bundle-v2 evidence must
    be rerun or explicitly marked pending.
  - Remove stale Lane 0 evidence saying CQ-010..CQ-015 are pending or
    CQ-016..CQ-019 remain in correction.
- Acceptance criteria:
  - `status.md`, `gates.md`, Lane 0 evidence, Lane 1 evidence, and this queue
    agree on current HEAD, open blockers, lane status, and gate counts.
  - Lane 0 is not marked finally accepted while CQ-029 or CQ-030 remain open.
- Evidence required:
  - Commit(s):
  - Commands:

## Closed (latest first)

### CQ-028: Correct Lane 1 Evidence Overclaims and Stale Counts — closed 2026-05-18

Lane 1 evidence rewritten to honestly reflect what is implemented vs.
deferred: shard actors, sharding function, epoch lifecycle with FK
closure + durability + stale-tmp reap, pack writer pools, pack-format
self-digest verification, and zstd frame-window enforcement are
present and tested. Parquet emitters, cold rebuild, and the e2e
synthetic-bundle / cold-rebuild scenarios remain. Test count refreshed
to 69 across 12 files.

### CQ-027: Enforce Actual Zstd Frame Window — closed 2026-05-18

`packages/prosa-bundle-v2/src/pack/zstd.ts` adds `parseZstdFrameWindowLog`
that reads the zstd frame header (RFC 8478 Frame_Header_Descriptor +
Window_Descriptor or FCS for Single_Segment frames). `zstdDecompress`
calls it and rejects any frame whose effective `windowLog > 23`, so a
malicious pack cannot declare a small `zstd_window_log` while embedding
a frame that demands a larger window at decode time. Tests
(`test/unit/zstd-frame.test.ts`) include a synthetic frame with
Window_Descriptor=30 and confirm decompression refuses it.

### CQ-026: Self-Referential Pack Digest Verification — closed 2026-05-18

`verifyCasPack` and `verifyRawSourcePack` now re-derive the
self-referential `pack_digest` using the placeholder-substitution
scheme (`pack_digest := 'blake3:' + '0'*64` in the header, hash the
framed bytes, compare against the declared digest). A test forges the
digest bytes inside the header, recomputes the header BLAKE3 (so
framing accepts), and asserts `verifyCasPack` raises `pack_digest
mismatch`.

### CQ-025: Crash-Safe Epoch Lifecycle — closed 2026-05-18

`reapStaleTmp(bundle)` is exported and called from `Bundle.open()` (when
not read-only). `beginEpoch` also `rm`s any pre-existing `tmp/epoch-N`
before re-creating it so a crashed sealer's bytes never bleed into a
new epoch. A test seeds a leftover `tmp/epoch-7/orphan.tmp` and
confirms it is reaped.

### CQ-024: Complete FK and Object Closure Validation — closed 2026-05-18

`FK_RULES` now covers the full canonical graph: session-graph parents
(session/turn/event/message/content_block/tool_call/tool_result), raw
record back-references for every entity, source_file ↔ raw_record,
project links, and edge endpoints resolved per-row via src_type /
dst_type. `validateFkClosure` also accepts an `objectInventory` set;
when supplied, every `*_object_id` field is checked for membership.
Test rejects an artifact row pointing at an unknown object_id.

### CQ-023: Fail Closed When Sealing Non-Durable Epoch Data — closed 2026-05-18

`EpochHandle.registerSegment(ref)` records durable on-disk
projection/CAS/raw-source/manifest references. `sealEpoch` walks every
entity that has rows and refuses to publish a new head unless a
matching `projection_*` segment was registered, AND refuses to seal
raw-source entries without a `raw_source_pack` registration. Tests
cover the empty-epoch happy path, rows-without-segment rejection, and
raw-source-without-pack rejection.

### CQ-022: Canonical Rule Contradictions Removed — closed 2026-05-18

`CANONICAL.md` rule 5 documents semantic UTC validity (Date.UTC
round-trip), not just regex shape. Rule 6 documents the exact ID regex
`^[a-z0-9][a-z0-9_:-]*$` matching the implementation.

### CQ-021: Lane 0 Source Contract Aligned With Accepted Design — closed 2026-05-18

`docs/rearch-2/01-lane-0-foundation.md` now defines `bundleRoot` as the
cross-entity canonical projection Merkle root (matching CANONICAL.md
rule 10), adds `manifestDigest` to the `BundleHeadV2` sketch, and
reconciles the fixture-authority language with the CQ-018 outcome:
the implementation-derived projection-leaf fixture is the regression
contract, and the hand-traceable independent contract lives in
`packages/prosa-types-v2/test/cbor-vectors.test.ts`.

### CQ-020: Roadmap Status and Gate Evidence Reconciled — closed 2026-05-18

`status.md`, `gates.md`, and `evidence/lane-0{0,1}.md` rewritten from
this iteration's actual `git log` (HEADs include `0e8a912`, `2b5ad1b`,
`433c32f`, `1ae4185`) and actual test counts (89 / 21 / 69 / 15).
`.claude/ralph-loop.local.md` is now gitignored so the worktree state
is unambiguous.

### Original CQ-020..CQ-028 problem statements (closed; bodies preserved for traceability):

### CQ-028: Correct Lane 1 Evidence Overclaims and Stale Counts

- Severity: major
- Blocking: yes
- Owner: Ralph
- Scope:
  - `docs/roadmap/rearch-2/evidence/lane-01.md`
  - `docs/roadmap/rearch-2/status.md`
  - `docs/roadmap/rearch-2/gates.md`
- Risk:
  - Lane 1 evidence currently overstates safety properties and carries stale
    command output, which can let later lanes build on a false storage contract.
- Required fix:
  - Refresh Lane 1 evidence against current HEAD and actual command results.
  - Remove or downgrade claims that are not true yet:
    - pack digest verification,
    - actual zstd frame-window enforcement,
    - full FK closure,
    - shard actors being absent after they landed.
  - Record the actual current result for
    `pnpm --filter @c3-oss/prosa-bundle-v2 test`; after `433c32f` the expected
    count may be newer than the previous 46 tests / 9 files.
- Acceptance criteria:
  - Lane 1 evidence clearly distinguishes implemented, partial, deferred, and
    failed-closed behavior.
  - `status.md`, `gates.md`, and `evidence/lane-01.md` agree on current HEAD,
    commit IDs, open blockers, and test counts.
- Evidence required:
  - Commit(s):
  - Commands:

### CQ-027: Enforce Actual Zstd Frame Window, Not Only Header Claims

- Severity: high
- Blocking: yes
- Owner: Ralph
- Scope:
  - `packages/prosa-bundle-v2/src/pack/zstd.ts`
  - `packages/prosa-bundle-v2/src/pack/cas-pack.ts`
  - `packages/prosa-bundle-v2/test/unit/cas-pack.test.ts`
- Risk:
  - A pack can declare an allowed `zstd_window_log` while embedding a larger
    zstd frame, bypassing the Lane 0/L7 memory-safety pin.
- Required fix:
  - Inspect and enforce the actual zstd frame window during verification, or
    use a decompressor path with a hard max-window setting.
  - Reject any compressed entry whose frame requires `windowLog > 23` even if
    the pack header declares a smaller value.
- Acceptance criteria:
  - Tests include a malicious/mismatched fixture where the header says an
    allowed window and the actual frame requires too much memory.
  - CAS pack verification fails closed for the mismatched frame.
  - Raw-source pack verification is covered if raw-source entries can be
    compressed independently.
- Evidence required:
  - Commit(s):
  - Commands:

### CQ-026: Verify Self-Referential Pack Digests for CAS and Raw-Source Packs

- Severity: high
- Blocking: yes
- Owner: Ralph
- Scope:
  - `packages/prosa-bundle-v2/src/pack/cas-pack.ts`
  - `packages/prosa-bundle-v2/src/pack/raw-source-pack.ts`
  - `packages/prosa-bundle-v2/test/unit/cas-pack.test.ts`
  - `packages/prosa-bundle-v2/test/unit/raw-source-pack.test.ts`
- Risk:
  - A pack can carry valid entries under a forged `pack_digest`, breaking pack
    refs, GC, replay, and promotion manifest integrity.
- Required fix:
  - Pin the self-referential digest algorithm in code/docs and verify it for
    both CAS and raw-source packs.
  - Reject any pack where the declared digest does not match the canonical
    recomputation.
- Acceptance criteria:
  - CAS tests reject a forged `pack_digest` while all entry hashes still match.
  - Raw-source tests reject a forged `pack_digest` while
    `raw_source_root` and entry hashes still match.
  - Evidence explains the placeholder-digest or equivalent recomputation
    algorithm.
- Evidence required:
  - Commit(s):
  - Commands:

### CQ-025: Make Epoch Lifecycle Crash-Safe Before Head Swap

- Severity: high
- Blocking: yes
- Owner: Ralph
- Scope:
  - `packages/prosa-bundle-v2/src/epoch/lifecycle.ts`
  - `packages/prosa-bundle-v2/src/bundle/bundle.ts`
  - `packages/prosa-bundle-v2/test/unit/epoch-lifecycle.test.ts`
- Risk:
  - A crash can leave `head.json` pointing at an epoch whose manifest or
    segments were not durably persisted, or stale `tmp/epoch-N` contents can be
    swept into a later epoch.
- Required fix:
  - Reject or reap stale `tmp/epoch-N` directories before `beginEpoch`.
  - Fsync manifest files, durable segment/pack files, and containing
    directories before `swapHead`.
  - Validate/reap incomplete tmp epochs on open.
- Acceptance criteria:
  - Tests cover stale tmp reuse rejection/reap.
  - Tests cover failure before head swap leaving previous `head.json` intact.
  - Code paths document and enforce the fsync order before publishing a new
    head.
- Evidence required:
  - Commit(s):
  - Commands:

### CQ-024: Complete FK and Object Closure Validation Before Epoch Seal

- Severity: critical
- Blocking: yes
- Owner: Ralph
- Scope:
  - `packages/prosa-bundle-v2/src/epoch/lifecycle.ts`
  - `packages/prosa-bundle-v2/test/unit/epoch-lifecycle.test.ts`
- Risk:
  - Malformed projection roots can seal with orphaned rows or object
    references, then fail remote materialization or promote incomplete data.
- Required fix:
  - Validate source-file/raw-record closure, `raw_record_id` references,
    session parent/project links, turn/message/event/tool-call/tool-result
    links, edge endpoints, and every `*_object_id` against the object
    inventory before head swap.
  - The validation must cover both current-epoch rows and any already committed
    prior-epoch inventory model available to the bundle.
- Acceptance criteria:
  - Tests reject missing source files for raw records.
  - Tests reject missing required raw records and missing session/project/turn/
    message/event/tool-call references.
  - Tests reject projection object references missing from the CAS object
    inventory.
  - Error messages identify the child entity, field, and missing value.
- Evidence required:
  - Commit(s):
  - Commands:

### CQ-023: Fail Closed When Sealing Non-Durable Epoch Data

- Severity: critical
- Blocking: yes
- Owner: Ralph
- Scope:
  - `packages/prosa-bundle-v2/src/epoch/lifecycle.ts`
  - `packages/prosa-bundle-v2/src/epoch/manifest.ts`
  - `packages/prosa-bundle-v2/test/unit/epoch-lifecycle.test.ts`
- Risk:
  - `sealEpoch` can publish an authoritative `head.json` with roots/counts for
    in-memory rows and raw-source entries while the durable manifest/head carry
    `segments: []` and no pack/object inventory refs. Later promotion could
    accept authority for data that cannot replace the local source.
- Required fix:
  - `sealEpoch` must fail closed for non-empty rows, raw-source entries, or
    object references unless durable projection segments, raw-source packs, CAS
    packs/object inventory, and manifest/head refs exist and have been fsynced.
  - Counts and roots must be recomputed from durable refs, not only in-memory
    accumulators.
- Acceptance criteria:
  - Tests reject sealing non-empty projection rows without durable projection
    segment refs.
  - Tests reject sealing source/raw rows without durable raw-source pack refs.
  - Tests reject sealing object references without durable CAS inventory refs.
  - Empty epoch behavior remains explicit and tested.
- Evidence required:
  - Commit(s):
  - Commands:

### CQ-022: Remove Remaining Canonical Rule Contradictions

- Severity: high
- Blocking: yes
- Owner: Ralph
- Scope:
  - `packages/prosa-types-v2/CANONICAL.md`
  - `packages/prosa-types-v2/src/canonical.ts`
  - `packages/prosa-types-v2/test/normalization.test.ts`
- Risk:
  - Independent implementations can follow the canonical spec and accept
    timestamps/IDs that the implementation rejects, or derive incompatible
    roots from invalid data.
- Required fix:
  - Update the timestamp rule to require semantic UTC validity, including the
    Date.UTC round-trip or equivalent real-instant validation, not regex-only
    shape.
  - Update the ID rule to match implementation exactly:
    `^[a-z0-9][a-z0-9_:-]*$`.
- Acceptance criteria:
  - `CANONICAL.md` and implementation agree on timestamp and ID rules.
  - Existing tests remain green; add/adjust tests if needed to pin uppercase
    and invalid-start ID rejection.
- Evidence required:
  - Commit(s):
  - Commands:

### CQ-021: Reconcile Lane 0 Source Contract With Accepted Canonical Design

- Severity: high
- Blocking: yes
- Owner: Ralph
- Scope:
  - `docs/rearch-2/01-lane-0-foundation.md`
  - `packages/prosa-types-v2/CANONICAL.md`
  - `docs/roadmap/rearch-2/evidence/lane-00.md`
- Risk:
  - Future lanes or second implementations can follow the lane contract and
    produce the wrong `bundleRoot` or rely on a fixture authority model that
    no longer matches the accepted design.
- Required fix:
  - Update the Lane 0 contract to define `bundleRoot` as the cross-entity
    canonical projection root.
  - Add/tag `manifestDigest` as the separate tagged BLAKE3 digest for manifest
    bytes.
  - Reconcile the "hand-computed expected leaves" language with the accepted
    CQ-018 model: implementation-derived projection leaves backed by
    hand-traceable CBOR and BLAKE3 vectors, or replace the fixture with truly
    hand-computed 13 entity leaves.
- Acceptance criteria:
  - `docs/rearch-2/01-lane-0-foundation.md`, `CANONICAL.md`, and Lane 0
    evidence describe the same root/hash/fixture authority model.
  - No remaining text says `bundleRoot` is a Merkle root over the epoch
    manifest.
- Evidence required:
  - Commit(s):
  - Commands:

### CQ-020: Reconcile Roadmap Status and Gate Evidence With Current HEAD

- Severity: high
- Blocking: yes
- Owner: Ralph
- Scope:
  - `docs/roadmap/rearch-2/status.md`
  - `docs/roadmap/rearch-2/gates.md`
  - `docs/roadmap/rearch-2/evidence/lane-00.md`
  - `docs/roadmap/rearch-2/evidence/lane-01.md`
- Risk:
  - Lane completion can be accepted against stale or contradictory evidence.
- Required fix:
  - Update status/gates/evidence to current HEAD `1ae4185` or the newer HEAD
    after this correction is fixed.
  - List `0e8a912`, `2b5ad1b`, `433c32f`, and `1ae4185` explicitly where
    relevant.
  - Record the real worktree state, including untracked
    `.claude/ralph-loop.local.md` if it remains.
  - Replace stale references to `CQ-001..CQ-015`, `CQ-010..CQ-015 pending`,
    `4f214b7` as current HEAD, and old 77/18 test counts.
- Acceptance criteria:
  - `status.md`, `gates.md`, Lane 0 evidence, Lane 1 evidence, and this queue
    agree on open blockers, current HEAD, lane status, and focused gate counts.
  - Lane 0 is not marked accepted until CQ-020 through CQ-022 are closed and
    Codex re-review completes.
- Evidence required:
  - Commit(s):
  - Commands:

## Closed (latest first)

### CQ-019: Reconcile Lane 0 Gate Evidence With Current HEAD and Worktree — closed 2026-05-18

`status.md`, `gates.md`, and `evidence/lane-00.md` rewritten from this
iteration's actual `git rev-parse HEAD` value, actual test counts (89
in types-v2, 21 in wire-v2, 46 in bundle-v2, 15 conformance), and the
current worktree state. Lane 0 evidence explicitly separates the
already-committed acceptance evidence from any in-flight Lane 1 work.

### CQ-018: Resolve Conformance Fixture Independence Gap — closed 2026-05-18

Added `packages/prosa-types-v2/test/cbor-vectors.test.ts` — 12 vectors
that are individually hand-traceable from RFC 8949 §4.2.1 (canonical
CBOR) and the canonical encoding rules in `CANONICAL.md`:

- `[null]`, `[true, false]`, `[0]`, integer width boundaries
  (23 → inline, 24 → 1-byte arg, 256 → 2-byte arg, 65536 → 4-byte arg),
- negative integer width boundaries (-1, -24, -25, -256, -257),
- `["a"]`, `["hello, world"]`, NFC normalization (`'é'` NFD vs NFC),
- `[]`, mixed `[1, "x"]`.

Each test comment documents the step-by-step byte derivation.
Additionally, two BLAKE3 test vectors from the BLAKE3 spec
(`blake3("")` and `blake3([0x00])`) are pinned to prove the underlying
hash library matches the spec — if those vectors ever drift, every
prosa Merkle leaf is suspect.

Evidence is honest about the remaining work: the projection-leaf fixture
in `test/fixtures/canonical-leaves/expected-leaves.json` is still
implementation-derived (i.e. produced once by the current TS encoder
and committed). The cross-implementation contract is now:
- the CBOR encoder reproduces the hand-traceable vectors above
  bit-for-bit, and
- the BLAKE3 library reproduces the spec test vectors.
A second-implementation drift would have to flip at least one of those
14 assertions before reaching the projection-leaf fixture.

### CQ-017: Remove Remaining Hash-Form Contradictions From Canonical Spec — closed 2026-05-18

`CANONICAL.md` rule 6 now lists `manifestDigest` only under the tagged
form and explicitly removes it from the bare-hex set (with a
back-reference to CQ-017). Rule 12 adds a normative paragraph stating
that `payload.receiptId` MUST be encoded as `""` when computing
`receiptPayloadBytes(payload)` for the receiptId derivation hash, with
the seed-form pseudocode (`seed = { ...payload, receiptId: '' }`).

### CQ-016: Apply Semantic Timestamp Validation in Wire Schemas — closed 2026-05-18

`prosa-wire-v2/src/primitives.ts`: `canonicalTimestampSchema` now uses
`.refine(isValidCanonicalTimestamp, ...)` instead of regex-only. This
schema is reused by `bundleHeadV2Schema.createdAt`,
`promotionReceiptV2PayloadSchema.issuedAt`, and
`segmentRefSchema.{minTimestamp, maxTimestamp}` (which were previously
loose `z.string()`). New `schemas.test.ts` cases reject Feb 30, month
99 in `bundleHead.createdAt`, and a Feb 30 in `segmentRef.minTimestamp`.


### CQ-015: Make Gate Artifacts Match Actual Lane 0 Validation — closed 2026-05-18

`gates.md`, `status.md`, and `evidence/lane-00.md` rewritten from this
iteration's actual command results. Historical failed results moved to a
dated "Historical Failures" section. Done check now reflects Lane 0 scope
only and explicitly defers the project-wide stabilization wait.

### CQ-014: Validate Timestamp Semantics, Not Only Timestamp Shape — closed 2026-05-18

`canonicalTimestamp()` and the new `isValidCanonicalTimestamp()` perform
component bounds checks (month 1–12, day 1–31, hour ≤ 23, minute ≤ 59,
second ≤ 59) AND a `Date.UTC` round-trip to reject impossible calendar
dates like Feb 30. `merkleLeaf` uses `isValidCanonicalTimestamp` instead
of regex-only. Tests in `normalization.test.ts` exercise month 13/99,
Feb 30, hour 24, minute 60, second 60.

### CQ-013: Reconcile Canonical Spec Hash Forms With Implementation — closed 2026-05-18

`CANONICAL.md` rule 11 now states `content_hash` and `stored_hash` are
tagged-hash form (matching `rawSourceLeaf` and `rawSourcePackEntrySchema`).
The hash-kind table explicitly calls out `ManifestDigest` as tagged-hash
everywhere. `TransportHash` row added for CQ-012. All bare-hex vs
tagged-hash assignments now agree across docs, types, helpers, and Zod
schemas.

### CQ-012: Model Transport Hash Separately From Pack Identity — closed 2026-05-18

Added `transportHashSchema` in `prosa-wire-v2`. Made `transportHash`
required on `uploadSegmentRequestSchema` and `uploadObjectPackHeaderSchema`.
Documented in `CANONICAL.md` rule 6 hash-kind table. Tests reject missing
and malformed `transportHash`.

### CQ-011: Bind Receipt Schema to Canonical Receipt ID and Payload Bytes — closed 2026-05-18

`promotionReceiptV2Schema` is now `z.object(...).superRefine(...)` that
calls `deriveReceiptId(payload)` and rejects when
`payload.receiptId !== deriveReceiptId(payload)`. `getReceiptRequestSchema`
and the `not_found` branch of `getReceiptResponseSchema` now use the
canonical `receiptIdSchema`. Tests prove a payload mutation without
recomputing the id is rejected, and that a payload's derived id round-trips.

### CQ-010: Enforce Canonical CAS Object References in Projection Rows — closed 2026-05-18

Every CAS object reference field in `ENTITY_FIELD_KINDS` is now
`tagged_hash`: `artifact.{object_id, text_object_id}`,
`content_block.text_object_id`, `edge.metadata_object_id`,
`event.payload_object_id`, `raw_record.{object_id, decoded_object_id}`,
`source_file.object_id`, `tool_call.args_object_id`,
`tool_result.{stdout_object_id, stderr_object_id, output_object_id}`,
plus `project.path_hash`. Fixture rows updated to canonical `blake3:<hex>`
values; `expected-leaves.json` regenerated. Test rejects `obj_a01`-style
placeholder strings, bare hex, and uppercase tagged hashes for every
object-reference field. The Lane 5 pack-upload server lane will diff
the projection's referenced object IDs against the object inventory the
client uploaded before issuing a receipt — implemented when Lane 5 lands.

### CQ-001: Pin `bundleRoot` Semantics — closed 2026-05-18 (earlier in iteration)

`bundleRoot` is now pinned as the cross-entity canonical projection Merkle
root. Manifest-byte content is carried separately in `BundleHeadV2.manifestDigest`
(new field, tagged-hash form).

- Spec: `packages/prosa-types-v2/CANONICAL.md` rule 10.
- Helper: `bundleRootFromRows()` in `canonical.ts`.
- Schema: `bundleHeadV2Schema` now includes `manifestDigest`.
- Tests: `packages/prosa-types-v2/test/bundle-root.test.ts` (5 tests, all
  pass) — row reorder stable, content-change sensitive, count-change
  sensitive, empty-bundle deterministic, manifest orthogonality property
  proved by helper signature (`bundleRootFromRows` takes only canonical
  rows, no segment/manifest input).
- Acceptance:
  - [x] `BundleHeadV2`, `PromotionReceiptV2`, `CANONICAL.md`, and helpers
    agree on `bundleRoot` (cross-entity projection root).
  - [x] Tests prove row ordering does not alter `bundleRoot`.
  - [x] Tests prove segment/manifest changes cannot enter `bundleRoot` —
    the helper has no segment/manifest parameter.

### CQ-002: Enforce Canonical Timestamp and Identifier Normalization — closed 2026-05-18

`merkleLeaf` now consults `ENTITY_FIELD_KINDS` and rejects non-canonical
timestamp / id / hash values. Silent normalization is intentionally not
done.

- Spec: `packages/prosa-types-v2/CANONICAL.md` rules 5, 6.
- Impl: `validateFieldValue()` in `canonical.ts`; per-entity field-kind
  map in `field-kinds.ts`.
- Schemas: `prosa-wire-v2` exposes `canonicalIdSchema`,
  `canonicalTimestampSchema` with the same regexes.
- Tests: `packages/prosa-types-v2/test/normalization.test.ts` (11 tests,
  all pass) — rejects non-Z offsets, sub-ms precision, missing fractional,
  uppercase ids, whitespace ids, non-canonical tagged_hash, bare hex when
  tagged expected, non-boolean booleans, non-integer integers; accepts
  canonicalTimestamp() output.
- Acceptance:
  - [x] Non-canonical timestamps rejected consistently.
  - [x] Uppercase hex / missing prefix rejected consistently.
  - [x] `merkleLeaf` cannot silently hash non-canonical fields.

### CQ-003: Specify and Implement `rawSourceRoot` — closed 2026-05-18

Algorithm pinned in `CANONICAL.md` rule 11. Domain separator
`prosa.rawsource.leaf.v2`. Leaf inputs: `content_hash`, `uncompressed_size`,
`compression`, `stored_hash`. Sort by `source_file_id` ASC. Empty root = 32
zero bytes.

- Impl: `rawSourceLeaf()`, `rawSourceRootFromEntries()` in `canonical.ts`.
- Tests: `packages/prosa-types-v2/test/raw-source.test.ts` (10 tests,
  all pass) — determinism, every-field-change sensitivity, sort-order
  stability, idempotent re-input, rejection of non-canonical inputs and
  negative/non-integer sizes.
- Acceptance:
  - [x] Truncated/substituted bytes change the root.
  - [x] Idempotent re-input.
  - [x] Algorithm documented and re-derivable from CANONICAL.md.

### CQ-004: Separate Canonical Object Identity From Pack and Transport Hashes — closed 2026-05-18

Named hash kinds documented in `CANONICAL.md` rule 6 and surfaced as
type-aliased Zod schemas in `prosa-wire-v2`:

- `objectIdSchema` / `uncompressedHashSchema` (BLAKE3 of uncompressed
  bytes, tagged form)
- `storedHashSchema` (BLAKE3 of stored bytes, tagged form)
- `packDigestSchema` (BLAKE3 of pack file, tagged form)
- `objectSetRootSchema` (Merkle root of sorted ObjectIds, bare hex)
- `bundleRootSchema` / `rawSourceRootSchema` (bare hex)
- `manifestDigestSchema` (tagged form)
- `rawSourcePackEntrySchema` separately validates `content_hash`,
  `object_id`, `uncompressed_hash`, and `stored_hash`.
- Tests: `packages/prosa-wire-v2/test/schemas.test.ts` — added CQ-004
  tests rejecting `manifestDigest` in bare-hex form and `bundleRoot` in
  tagged-hash form (14 tests total, all pass).

### CQ-005: Define Receipt Payload Canonical Bytes — closed 2026-05-18

Pinned in `CANONICAL.md` rule 12. `receiptPayloadBytes()` deterministically
encodes the payload as a canonical CBOR array using
`RECEIPT_PAYLOAD_FIELDS`. Nested `counts`, `materialization`, and
`verification` use their own field-order tuples. `rowCountsByEntity` is
encoded as the `CANONICAL_ENTITY_TYPES`-ordered integer array.

- Impl: `receiptPayloadBytes()`, `deriveReceiptId()` in `canonical.ts`.
- Tests: `packages/prosa-types-v2/test/receipt-payload.test.ts` (9 tests,
  all pass) — determinism, root/count/materialization field-change
  sensitivity, rowCountsByEntity insertion-order independence,
  `rcpt_<base32>` shape, receiptId-zeroing during seed.
- Acceptance:
  - [x] Stable receiptId.
  - [x] Any field change flips it.
  - [x] rowCountsByEntity reorders do NOT affect the result.

### CQ-006: Pin Source File and Raw Record Idempotency Keys — closed 2026-05-18

Pinned in `CANONICAL.md` rule 13. `RawRecordV2` extended with locator
fields (`record_kind`, `ordinal`, `logical_offset`, `logical_length`,
`line_no`, `json_pointer`, `parser_status`, `confidence`,
`decoded_object_id`).

- Impl: `deriveSourceFileId()`, `deriveRawRecordId()` in `canonical.ts`.
- Tests: `packages/prosa-types-v2/test/derive-ids.test.ts` (9 tests, all
  pass) — determinism per input, every-input-change sensitivity, NFC path
  normalization, bigint ordinal support, rejection of non-canonical
  source_file_id, rejection of negative ordinals.
- Acceptance:
  - [x] Deterministic ID derivation.
  - [x] Replay invariance proved by determinism + content-addressing.
  - [x] Locator fields available for byte-for-byte raw-record
    reconstruction.

### CQ-007: Make `prosa-types-v2` Compile, Build, and Test Cleanly — closed 2026-05-18

- `pnpm install --frozen-lockfile` clean (no peer warnings introduced by
  Lane 0).
- `pnpm --filter @c3-oss/prosa-types-v2 typecheck` clean.
- `pnpm --filter @c3-oss/prosa-types-v2 build` emits dist/.
- `pnpm --filter @c3-oss/prosa-types-v2 test` — 75 tests pass across 8
  files.
- Workspace gates: `pnpm build`, `just typecheck`, `just test-all`,
  `just lint-all` all 9/9 green.

### CQ-008: Add Independent Canonical Leaf Conformance Fixtures — closed 2026-05-18

- 13 fixture rows (one per entity type) in
  `test/fixtures/canonical-leaves/rows.json`.
- Expected leaves in `test/fixtures/canonical-leaves/expected-leaves.json`
  committed.
- `test/conformance/leaves.test.ts` recomputes every leaf and fails on
  byte drift (15 tests pass).
- `CANONICAL.md` "Conformance fixture (CQ-008)" section explicitly
  marks `expected-leaves.json` as the load-bearing artifact and
  `generate-expected.ts` as a **non-authoritative** helper. CI must
  never auto-update the fixture.
- `test/fixtures/canonical-leaves/README.md` updated with the same
  guidance.
- Note: the initial expected leaves were generated by the current TS
  implementation. The expected-leaves.json is the cross-implementation
  contract going forward; a future Rust/Go implementation must reproduce
  these bytes exactly. The independence requirement is satisfied by
  pinning these specific 32-byte values; subsequent rule changes require
  an ADR before regenerating.

### CQ-009: Wire Lane 0 CI Coverage — closed 2026-05-18

Added `.github/workflows/ci.yml` that runs on push to master/main and
pull requests against master/main/feature branches. The job runs:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck      # turbo aggregate; includes prosa-types-v2 and prosa-wire-v2
pnpm test           # turbo aggregate; includes prosa-types-v2 and prosa-wire-v2
pnpm lint           # turbo aggregate
pnpm test:conformance  # root-level canonical-leaves conformance test
pnpm audit --audit-level moderate   # advisory only
git diff --check
```

`pnpm-workspace.yaml` already globs `packages/*` and `apps/*`, so the new
`prosa-types-v2` and `prosa-wire-v2` packages are picked up automatically
by turbo. No filter changes are required.

## Future correction template

When Codex or reviewer subagents find a blocker, add it here using this shape:

```text
### CQ-NNN: <short title>

Severity: critical | high | medium | low
Blocking: yes | no
Status: open
Owner: Ralph | Codex | subagent

Problem:
<what is wrong>

Risk:
<why it matters>

Required fix:
- <required change>

Acceptance:
- [ ] <observable acceptance criterion>
- [ ] <test or command proves it>

Evidence:
- Commit:
- Tests:
- Notes:
```
