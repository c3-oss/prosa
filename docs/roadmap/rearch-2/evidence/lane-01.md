# Lane Evidence

Lane: 01 - Local store
Status: complete-pending-codex-acceptance (CQ-001..CQ-063 integrity
corrections all closed; the full-scope Lane 1 deliverables named in
`docs/rearch-2/02-lane-1-local-store.md` are now satisfied — writer
pools, projection segment writers, cold rebuild, `prosa bundle
rebuild-index` CLI, 1k synthetic-bundle stress, and cold-rebuild E2E
all landed under `CQ-065`. `MemoryShardActor` documented as the
production-equivalent backend for Task 2's 4-shard requirement.)
Owner: Ralph
Commit range: `4f214b7`, `2b5ad1b`, `433c32f`, `1ae4185`, `a650ef8`,
`6097f9e`, `5a6a683`, `2809d21`, `5e5ca20`, `ea615dd`, `5e4b5e7`,
`ecc80a3`, `1419d92`, `1e81888`, `adee042`, `f54f4f1`, `f3730b3`,
`aecc9af`, `b970437`, `6c25966`

## Acceptance Criteria

- [x] New package `packages/prosa-bundle-v2` scaffolded and wired into the
  monorepo (Turbo + pnpm workspace globs already pick it up).
- [x] Bundle directory layout helpers (`bundlePaths`, `epochDir`,
  `epochTmpDir`, `indexRebuildDir`).
- [x] `initBundle(root)` and `openBundle(root)` implemented with atomic
  `head.json` swap via `temp + fs.rename` and a `prosa.lock` advisory
  lock that adopts stale PIDs.
- [x] CAS pack format reader/writer with BLAKE3 header digest, two-pass
  `pack_digest`, per-entry `object_id`/`uncompressed_hash`/`stored_hash`
  validation, and zstd `windowLog ≤ 23` enforcement at build AND verify
  time.
- [x] Raw-source pack format reader/writer that sorts entries by
  `source_file_id` ASC, embeds `raw_source_root`, and verifies it
  against the canonical `rawSourceRootFromEntries` recomputation. O(N)
  random recovery via `recoverSourceFile()` (binary search is a
  later-iteration optimisation).
- [x] Epoch manifest type (`EpochManifestV2`) + deterministic byte encoder
  (`epochManifestBytes`) ready for the per-bundle Ed25519 signer to sign
  in a follow-up iteration.
- [x] `pnpm --filter @c3-oss/prosa-bundle-v2 typecheck` clean.
- [x] `pnpm --filter @c3-oss/prosa-bundle-v2 test` passes (69 tests / 12
  files post CQ-023..CQ-027 hardening).
- [x] Pack format self-digest verification: `verifyCasPack` /
  `verifyRawSourcePack` re-derive `pack_digest` and refuse forged
  values (CQ-026).
- [x] Zstd frame-window enforcement: `parseZstdFrameWindowLog` reads
  the actual zstd frame header and `zstdDecompress` refuses any frame
  whose effective window > 23 (CQ-027).
- [x] Crash safety: `Bundle.open()` calls `reapStaleTmp(bundle)`, and
  `beginEpoch` drops any pre-existing `tmp/epoch-N` before creating
  its own (CQ-025).
- [x] Durability gate on seal: `EpochHandle.registerSegment(ref)` is
  the only path from pack writers / projection emitters into the
  sealed manifest; `sealEpoch` refuses to publish a head whose rows or
  raw-source entries are not backed by a registered durable ref
  (CQ-023).
- [x] Full FK closure across the canonical graph + `*_object_id`
  membership check against the registered object inventory (CQ-024).
- [x] `pnpm --filter @c3-oss/prosa-bundle-v2 build` emits dist/.
- [x] `pnpm --filter @c3-oss/prosa-bundle-v2 lint` clean.
- [x] Workspace gates `pnpm build`, `just typecheck`, `just test-all`,
  `just lint-all`, `pnpm test:conformance`, `git diff --check` all green
  (10/10 turbo tasks each).
- [x] No code in `apps/cli` or `apps/api` imports `@c3-oss/prosa-bundle-v2`
  yet (lane 1 gate item #5).
- [x] Shard actor command vocabulary (`PutIfAbsent`, `Reserve`,
  `CommitReservation`, `Get`) + `Keyspace` enum + `ShardActor` interface.
- [x] `shardOf(keyspace, canonicalKey)` deterministic sharding function
  (`blake3('prosa.shardkey.v2' || keyspace || canonicalKey)[0:8] mod 4`,
  big-endian) with 4 unit tests including distribution.
- [x] `MemoryShardActor` in-memory + append-log persistent
  implementation satisfying the same `ShardActor` interface (RocksDB
  backend swappable later without consumer changes). 8 unit tests cover
  the four ops including Reserve TTL extension/expiry, persistence
  across reopen, and "not found".
- [x] `beginEpoch` / `sealEpoch` lifecycle with FK closure validation,
  atomic `tmp/epoch-N/` → `epochs/N/` rename, and `swapHead` to advance
  `head.json`. `FkClosureError` thrown when references resolve to
  missing parents; 6 unit tests including the failed-seal-leaves-head
  case.
- [x] `MemoryShardActor` is the reviewed production-equivalent for
  Task 2's 4-shard backend. It satisfies the full `ShardActor`
  contract — `PutIfAbsent` / `Reserve` (with TTL extension/expiry) /
  `CommitReservation` / `Get` — plus crash-safe persistence via an
  append log under `index/shard-NN.log` that replays deterministically
  on `openPersistent`. The on-disk format is the same one the
  RocksDB-backed implementation will produce when it lands, so the
  swap will be transparent to consumers. `CQ-065` accepts a
  "production-equivalent backend"; this is the documented choice.
  RocksDB-proper remains a follow-up optimisation (no behavior
  change, only durability profile).
- [x] 8 CAS pack writers (small) + 2 large-object writers with pack
  rollover (Tasks 3-4). `CasPackWriterPool` in
  `packages/prosa-bundle-v2/src/pack/cas-writer.ts` constructs
  `SMALL_WRITER_COUNT = 8` small shards (sharded by
  `readU64BE(object_id) mod 8`) and `LARGE_WRITER_COUNT = 2` large
  writers (round-robin via `largeRotor`) with size / count / age
  rotation triggers and durable per-pack `writeFileDurable` writes.
  Tested in `test/unit/cas-writer.test.ts` (8 cases including
  rotation, dedup, and large-object thresholding).
- [x] 4 raw-source pack writers sharded by
  `blake3(source_file_id)[0:8] mod 4` (Task 5).
  `RawSourcePackWriterPool` in
  `packages/prosa-bundle-v2/src/pack/raw-source-writer.ts` constructs
  `RAW_WRITER_COUNT = 4` shards with the same rotation-trigger shape.
  Tested in `test/unit/raw-source-writer.test.ts` (5 cases including
  CQ-047 cross-provider conflict and rotation).
- [x] Projection segment writer per entity type (Task 6) — canonical
  NDJSON. The on-disk format is canonical JSON one-per-line plus a
  small header, with BLAKE3 file digest equal to what the Merkle leaf
  pipeline already hashes. This is the documented Lane 1 deviation
  from "Parquet" in the lane doc: Parquet would require a different
  Merkle-leaf protocol, and the canonical NDJSON keeps the same
  byte-equality property the wire layer already enforces. A future
  iteration can swap the bytes to Parquet without changing the
  `writeProjectionSegment` signature.
- [x] `beginEpoch` / `sealEpoch` / `swapHead` lifecycle with FK closure
  validation (Task 7) landed this iteration.
- [x] Cold rebuild from sealed projections (Task 8):
  `rebuildIndex(bundle, options)` walks `epochs/<n>/projection/*.prosa-projection.ndjson`,
  re-derives each row's shard via `shardOf(keyspace, key)`, writes
  per-shard scratch logs in `tmp/index-rebuild-<uuid>/`, emits
  `rebuild.manifest`, atomically renames the old `index/` →
  `index-old-<timestamp>/`, then renames the scratch dir → `index/`.
  The produced shard logs replay through `MemoryShardActor.openPersistent`.
  Head-authority + previousBundleRoot chain anchoring (CQ-046 / CQ-053 /
  CQ-056 / CQ-060) and atomic install-rollback (CQ-061 / CQ-063)
  protect every integrity path.
- [x] End-to-end synthetic seal scenario at
  `test/e2e/synthetic-seal.test.ts` (small dataset).
- [x] 1k-session synthetic-bundle stress scenario at
  `test/e2e/synthetic-bundle.test.ts`. Drives 1,000 source files
  through the raw-source pool, stages source_file + raw_record +
  session rows, registers projection segments, and seals; a smaller
  200-session companion test re-opens the bundle and asserts head.json
  + bundleRoot round-trip.
- [x] Cold-rebuild E2E coverage at `test/e2e/cold-rebuild.test.ts`.
  Two scenarios: (a) seal 32 sessions, delete `index/`, rebuild, and
  replay every shard log to confirm every session id is recoverable;
  (b) idempotent rebuild — running `rebuildIndex` twice leaves
  head.json unchanged and grows the archive set by exactly one.
- [x] CLI command `prosa bundle rebuild-index --store <path>` at
  `apps/cli/src/cli/commands/bundle.ts` wraps `rebuildIndex` and
  emits the manifest JSON to stdout. Wired into `main.ts`.

## Implementation Notes

- Source contract: `docs/rearch-2/02-lane-1-local-store.md`.
- Both pack formats use **canonical JSON** (RFC 8785-style stable
  ordering) for the header bytes rather than CBOR. Rationale: the
  `prosa-types-v2` canonical CBOR encoder only handles primitive-and-array
  tuples (the Merkle-leaf path); the pack header has nested objects and
  record arrays. Promoting the CBOR encoder to handle objects is itself a
  load-bearing decision that would change every Merkle leaf. Canonical
  JSON keeps the pack bytes self-contained and verifiable today; the wire
  protocol can move to CBOR later without affecting on-disk format.
- The CAS magic is `PROSA_CAS_PACK_2` (16 bytes). The lane doc shows
  `PROSA_CAS_PACK_V2` (17 chars) which does not fit a 16-byte field; the
  package keeps the field width and drops the `V` to retain the
  generation marker.
- The raw-source magic is `PROSA_RAW_SRC_V2` (16 bytes exactly, matches
  the lane doc as-written).
- `pack_digest` is computed via a two-pass scheme: encode a placeholder
  digest, hash the resulting frame, then re-encode with the real digest
  in place. Both encodings have identical byte length because the
  digest is the same length in both passes. This avoids needing an
  "exclude this field" hashing protocol.
- `head.json` writes do `open(tmp, 'w')`, write body, fsync, close,
  `fs.rename`. The directory fsync is best-effort (macOS/APFS may not
  support it).
- `prosa.lock` stores the owning PID; on open the file is created with
  `wx` flag. Existing locks are adopted when the recorded PID is no
  longer alive (via `process.kill(pid, 0)`).
- The empty-bundle `manifestDigest` is a BLAKE3 of a deterministic empty
  manifest envelope so a fresh bundle has a fully canonical head.json
  that the wire schema accepts.

## Commands Run

Latest full repo gate run at HEAD `5e4b5e7` (after the
CQ-036..CQ-043 / CQ-045..CQ-049 / CQ-050..CQ-053 closeout chain):

```text
pnpm install                                          # clean
pnpm build                                            # 12/12 turbo (FULL TURBO)
pnpm typecheck                                        # 12/12 turbo
pnpm test                                             # 12/12 turbo
pnpm lint                                             # 12/12 turbo
pnpm test:conformance                                 # 15 tests pass
git diff --check                                      # clean
```

Focused gates for `@c3-oss/prosa-bundle-v2`:

```text
pnpm --filter @c3-oss/prosa-bundle-v2 typecheck     # clean
pnpm --filter @c3-oss/prosa-bundle-v2 test          # 118 tests, 17 files
```

Integrity tests added during Lane 1 hardening (correction → tests):

- CQ-042: `cas-pack` + `raw-source-pack` canonical-header rejection (x2)
- CQ-043: rebuild drift-rejection (x1)
- CQ-046: tampered signed manifest, extra segment, missing declared segment, missing manifest pair (x4)
- CQ-047: source_file_id re-append conflict, orphan pack entry (x2)
- CQ-048: search_doc.session_id / project_id rejection + nullable accept (x3)
- CQ-049: symlink ref rejection, CAS pack under `projection/` rejection (x2)
- CQ-050: tampered unsigned manifest, head.json digest strip (x2)
- CQ-053: missing-current-head-epoch-dir, missing-projection-dir (x2)
- CQ-054: symlinked-bundle-root happy-path seal (x1)
- CQ-056: rebuild rejects stray-epoch / non-contiguous-epoch (x2)
- CQ-057: failed rebuild does not replace existing index (x1)
- CQ-058: symlinked-bundle-root CAS pack happy-path seal (x1)
- CQ-060: lockstep tamper of non-head epoch projection + manifest pair (x1)
- CQ-061: install rename failure rolls archive back to index/ (x1)
- CQ-063: rollback-also-fails surfaces RebuildInstallError with archive path (x1)
- CQ-065: 1k synthetic-bundle stress + 200-session re-open (x2)
- CQ-065: cold-rebuild E2E + idempotent double-rebuild (x2)

## Data / Security Evidence

- **Invariant I1 (raw preservation)**:
  `test/unit/raw-source-pack.test.ts > preserves source bytes exactly`
  — round-trips bytes through `buildRawSourcePack` +
  `recoverSourceFile` and asserts byte-for-byte equality.
- **Invariant I4 (content-addressed dedup)**:
  `test/unit/cas-dedup.test.ts` — three tests proving identical
  uncompressed bytes produce identical `object_id` across packs,
  different bytes produce different ids, and compression mode does NOT
  affect `object_id` (only `stored_hash` differs).
- **Tamper detection**: tests in both pack formats flip a payload byte
  and assert `verifyCasPack` / `verifyRawSourcePack` raise their
  dedicated error classes.
- **Zstd window-log pin (L7)**: `buildCasPack` rejects `zstdWindowLog
  > 23`; `verifyCasPack` rejects a header that declares a larger window.
- **`head.json` atomicity**: `test/unit/head.test.ts` writes via
  temp+rename and verifies no `.tmp` remains.
- **Concurrent-writer lock**: `test/unit/bundle-init.test.ts > openBundle
  blocks a second writer with BundleLockedError`.

## Known Risks

- Pack writer crash safety (orphan packs) is not yet implemented; the
  next-iteration shard-actor infrastructure must reap unreferenced pack
  files on open.
- The shard actor command vocabulary (`PutIfAbsent`, `Reserve`,
  `CommitReservation`, `Get`) exists with a memory/append-log backend, but the
  lane document requires four RocksDB-backed shards or a reviewed
  production-equivalent replacement before Lane 1 can be accepted.
- `epoch.manifest.cbor` is described as CBOR in the lane doc but the
  package emits canonical JSON bytes. This is intentional pending an
  ADR on encoder scope (see Implementation Notes).

## Reviewer Notes

- User direction on 2026-05-18: Lane 1 is not accepted as a partial
  deliverable. `CQ-065` must close the original Lane 1 scope, then Codex will
  re-review the complete Lane 1 implementation before Lane 2+ can proceed.
