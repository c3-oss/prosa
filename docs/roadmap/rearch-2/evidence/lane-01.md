# Lane Evidence

Lane: 01 - Local store
Status: substantially complete (foundational layers, shard actors, epoch
lifecycle with durability + FK closure + stale-tmp reap, pack writer
pools, pack-format self-digest verification, zstd frame-window
enforcement, canonical projection segment writer, e2e synthetic seal,
and cold rebuild from sealed projections all landed; only the
1k-session synthetic-bundle stress scenario from the lane doc remains)
Owner: Ralph
Commit range: `4f214b7`, `2b5ad1b`, `433c32f`, `1ae4185`, `a650ef8`, `6097f9e`, (+this iteration's cold-rebuild commit)

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
- [ ] 4 RocksDB shards backing the `ShardActor` interface (Task 2 of
  the lane doc explicitly names RocksDB). Deferred — the `MemoryShardActor`
  is a drop-in replacement for now.
- [ ] 8 CAS pack writers (small) + 2 large-object writers with pack
  rollover (Tasks 3-4) — pack format landed; the writer/rotor
  infrastructure is the next-iteration scope.
- [ ] 4 raw-source pack writers sharded by `blake3(source_file_id)[0:8]
  mod 4` (Task 5) — pack format landed; sharded writer pool is the
  next-iteration scope.
- [ ] Parquet projection segment writers per entity type (Task 6).
- [x] `beginEpoch` / `sealEpoch` / `swapHead` lifecycle with FK closure
  validation (Task 7) landed this iteration.
- [x] Cold rebuild from sealed projections (Task 8):
  `rebuildIndex(bundle, options)` walks `epochs/<n>/projection/*.prosa-projection.ndjson`,
  re-derives each row's shard via `shardOf(keyspace, key)`, writes
  per-shard scratch logs in `tmp/index-rebuild-<uuid>/`, emits
  `rebuild.manifest`, atomically renames the old `index/` →
  `index-old-<timestamp>/`, then renames the scratch dir → `index/`.
  The produced shard logs replay through `MemoryShardActor.openPersistent`.
- [x] End-to-end synthetic seal scenario at
  `test/e2e/synthetic-seal.test.ts` (small dataset).
- [ ] 1k-session synthetic-bundle stress scenario from the lane doc
  remains for a follow-up iteration.

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
pnpm --filter @c3-oss/prosa-bundle-v2 test          # 114 tests, 15 files
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
  `CommitReservation`, `Get`) is declared in
  `docs/rearch-2/02-lane-1-local-store.md` but no implementation exists
  in this iteration. Lane 2 importers cannot land until those actors
  exist.
- `epoch.manifest.cbor` is described as CBOR in the lane doc but the
  package emits canonical JSON bytes. This is intentional pending an
  ADR on encoder scope (see Implementation Notes).

## Reviewer Notes

- This iteration intentionally ships a **partial Lane 1** with the
  foundational on-disk pieces (layout, lock, head atomic swap, both pack
  formats, epoch manifest types) so Lanes 2-onwards can begin reasoning
  against concrete types and helpers.
- Codex / `prosa-architect` review of the partial deliverable will
  surface any blockers that must close before the rest of Lane 1.
