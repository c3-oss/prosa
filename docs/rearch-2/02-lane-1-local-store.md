# Lane 1 — Local store

## Goal

Ship the bundle v2 local store: directory layout, 4 RocksDB shards with single-writer actors, CAS pack writers (8 small + 2 large), raw source pack writers with offset index, Parquet projection segment writers, atomic `head.json` swap, and scratch-and-rename cold rebuild. After this lane, a bundle v2 can be initialized and synthetic data can be written via the shard-actor command vocabulary, sealed via epoch swap, and read back. **No importer logic exists yet** — that comes in Lane 2.

This is the largest lane. Plan for 5–7 PRs.

## Depends on

- Lane 0 (Foundation) complete. The shard actor uses `BundleHeadV2`, `SegmentRef`, `PackRef`, `SourceStateV2`, and the canonical encoding helpers from `prosa-types-v2`.

## Deliverables

- New package `packages/prosa-bundle-v2` exporting:
  - `initBundle(path) → Promise<Bundle>`
  - `openBundle(path) → Promise<Bundle>`
  - Shard actor command surface: `PutIfAbsent`, `Reserve`, `CommitReservation`, `Get`
  - Pack writer surface: `appendCasObject`, `appendRawSourceFile`, `appendProjectionRow`
  - Epoch lifecycle: `beginEpoch`, `sealEpoch`, `swapHead`
- New package `packages/prosa-bundle-v2-cas` (split for testability) implementing CAS pack format.
- New package `packages/prosa-bundle-v2-raw` implementing raw_source pack format.
- Cold-rebuild tool: `prosa bundle rebuild-index` CLI command.
- Tests covering all 5 invariants (raw preservation, idempotency, content-addressed dedup, plus FK validation at seal, plus cold rebuild crash safety).

## Tasks

1. **Bundle layout + `head.json` atomic swap.** Implement `initBundle`, `openBundle`, the on-disk directory shape. `head.json` is written via `fs.writeFile` to a temp file + `fs.rename` for atomicity. Open under `prosa.lock` advisory lock.
2. **4 RocksDB shards with actor model.** Each shard runs as a worker (Node `worker_threads` or async actor in same process). Shard function: `blake3('prosa.shardkey.v2' || keyspace || canonicalKey)[0:8] mod 4`. Command channel via async queue. Each shard handles `PutIfAbsent`, `Reserve` (with TTL), `CommitReservation`, `Get`.
3. **CAS pack writers (8 small).** Object sharding: `blake3(object_id)[0:8] mod 8`. Each writer owns its own temp file + zstd encoder context. Pack rollover triggers: `target_pack_bytes = 64 MiB`, `max_pack_bytes = 128 MiB`, `max_objects = 65536`, `max_open_ms = 2000`. **Critical**: zstd encoder must use `windowLog <= 23` (8 MiB) per Lane 0 canonical rules + L7 pin.
4. **CAS pack writers (2 large).** Objects ≥ 32 MiB are single-entry standalone packs. The two writers are concurrency limiters for read → compress → fsync, not poolers.
5. **Raw source pack writers (4).** Sharded by `blake3(source_file_id)[0:8] mod 4`. Pack format from `docs/rearch/14-proposal-2.md` lines 1080–1122. Entries sorted by `source_file_id`. Per-entry offset index in header for O(1) random recovery.
6. **Parquet projection segment writers (one per entity type).** Use existing DuckDB Parquet emit path; sort rows by primary key before write so leaves match the canonical Merkle order. Compression zstd-1, `ROW_GROUP_SIZE 100000` (carried over from v1 tuning).
7. **Epoch lifecycle.** `beginEpoch(bundle)` returns an `EpochHandle` writing to `tmp/epoch-<n>/`. `sealEpoch(handle)` validates FK closure across shards (in-memory HashSet + mmap-backed sorted table from prior epochs), computes Merkle roots, fsyncs every segment, writes `epoch.manifest.cbor`, atomically renames `tmp/epoch-<n>/` → `epochs/<n>/`, then `swapHead(bundle)` rewrites `head.json` atomically.
8. **Cold rebuild.** `prosa bundle rebuild-index --new-uuid <uuid>` creates `index-rebuild-<uuid>/`, populates 4 RocksDB shards from epoch manifests + Parquet segments, writes `rebuild.manifest`, fsyncs, then atomically renames old `index/` → `index-old-<timestamp>/` and `index-rebuild-<uuid>/` → `index/`. On startup, any `index-rebuild-*` directory without a complete `rebuild.manifest` is deleted.

Each task is roughly one PR. Tasks 1, 7, 8 are the most critical for correctness.

## Concrete types and schemas

### Bundle directory layout

```text
<bundle-v2>/
├── head.json
├── prosa.lock                       # advisory lock (single-writer per process)
├── epochs/
│   └── <n>/                         # immutable once renamed from tmp/
│       ├── epoch.manifest.cbor      # signed by bundle key (not server key)
│       ├── projection/
│       │   ├── sessions.parquet
│       │   ├── turns.parquet
│       │   ├── events.parquet
│       │   ├── messages.parquet
│       │   ├── content_blocks.parquet
│       │   ├── tool_calls.parquet
│       │   ├── tool_results.parquet
│       │   ├── artifacts.parquet
│       │   ├── edges.parquet
│       │   ├── raw_records.parquet
│       │   ├── projects.parquet
│       │   └── source_files.parquet
│       ├── search_docs.arrow.zst
│       └── session_blobs/
│           └── pack-<digest>.prosa-session-blob
├── cas/
│   ├── packs/
│   │   └── pack-<digest>.prosa-cas-pack
│   └── large/
│       └── <digest>.zst
├── raw_sources/
│   └── packs/
│       └── source-pack-<digest>.prosa-raw-pack
├── index/
│   ├── shard-00.rocksdb/
│   ├── shard-01.rocksdb/
│   ├── shard-02.rocksdb/
│   └── shard-03.rocksdb/
├── search/
│   └── tantivy/                     # built in Lane 3, referenced from epoch
└── tmp/
    ├── epoch-<n>/                   # in-progress epoch
    └── index-rebuild-<uuid>/        # cold rebuild scratch
```

### Shard actor command vocabulary

```ts
// packages/prosa-bundle-v2/src/shard/commands.ts

export type ShardCommand =
  | { op: 'PutIfAbsent'; keyspace: Keyspace; key: Uint8Array; value: Uint8Array }
  | { op: 'Reserve'; keyspace: Keyspace; key: Uint8Array; ttlMs: number; owner: ReserveOwner }
  | { op: 'CommitReservation'; keyspace: Keyspace; key: Uint8Array; owner: ReserveOwner; value: Uint8Array }
  | { op: 'Get'; keyspace: Keyspace; key: Uint8Array }

export type Keyspace =
  | 'source_file'    // source_files natural key
  | 'raw_record'     // raw_records UNIQUE
  | 'object'         // CAS objects PK
  | 'session'        // sessions UNIQUE
  | 'project'        // projects UNIQUE
  | 'edge'           // edges UNIQUE
  | 'reservation'    // active Reserve records

export type ShardResponse =
  | { ok: true; existed: boolean; value: Uint8Array | null }
  | { ok: false; error: 'reserved_by_other' | 'reservation_expired' | 'not_found' | 'serialization_error' }
```

### CAS pack format (binary)

```text
0       16 bytes   magic = "PROSA_CAS_PACK_V2"
16      u16le      version = 2
18      u16le      flags
20      u32le      header_len
24      32 bytes   header_blake3
56      N bytes    canonical CBOR CasPackHeaderV2
56+N    M bytes    payload: concatenated stored entries (each zstd-compressed with windowLog ≤ 23)
```

```ts
export type CasPackHeaderV2 = {
  pack_digest: string                // blake3 of header_bytes || payload_bytes
  created_at: string
  compression_default: 'zstd' | 'none'
  zstd_window_log: number            // <= 23
  entry_count: number
  entries: CasPackEntryV2[]
  standalone_large_object: boolean
}

export type CasPackEntryV2 = {
  object_id: string                  // 'blake3:<hex>'
  uncompressed_hash: string          // same hex as object_id
  uncompressed_size: number
  stored_offset: number
  stored_length: number
  stored_hash: string                // blake3 over stored bytes slice
  compression: 'zstd' | 'none'
  mime_type?: string
  encoding?: string
}
```

### Raw source pack format

Same byte-level shape as CAS pack but `magic = "PROSA_RAW_SRC_V2"`, header carries `RawSourcePackHeaderV2` with per-entry `source_file_id`, `path`, `mtime_ns`, `content_hash`. See `docs/rearch/14-proposal-2.md` lines 1080–1122 for the full schema.

### `epoch.manifest.cbor`

```ts
export type EpochManifestV2 = {
  bundleFormat: 2
  storeId: string
  epoch: number
  parserVersion: string
  createdAt: string
  previousEpoch: number | null
  previousBundleRoot: string | null

  bundleRoot: string
  rawSourceRoot: string

  segments: SegmentRef[]
  counts: BundleHeadV2['counts']
}
```

The manifest is sealed with a per-bundle Ed25519 key (generated at `initBundle`). The server does NOT validate this signature; it is for local tamper detection only.

## Tests

| File | Asserts |
|---|---|
| `packages/prosa-bundle-v2/test/init-open.test.ts` | `initBundle` + `openBundle` round-trip; `prosa.lock` blocks second concurrent opener. |
| `packages/prosa-bundle-v2/test/shard-actor.test.ts` | `PutIfAbsent` is atomic; concurrent `Reserve` from two workers — only one wins; reservation TTL expiry releases the key. |
| `packages/prosa-bundle-v2/test/cas-pack-format.test.ts` | Pack header round-trips; entries validate against `stored_hash` and `object_id`; rejects `window_log > 23`. |
| `packages/prosa-bundle-v2/test/raw-preservation.test.ts` | **Invariant I1**: every input source file is recoverable byte-for-byte from the raw_source pack at `(pack_digest, stored_offset, stored_length)`. |
| `packages/prosa-bundle-v2/test/cas-dedup.test.ts` | **Invariant I4**: same content from two sources produces one `objects` row and one pack entry. |
| `packages/prosa-bundle-v2/test/epoch-seal.test.ts` | FK closure validation: an edge referencing a non-existent session causes seal to fail with `INVALID_FK_REF`. |
| `packages/prosa-bundle-v2/test/epoch-atomicity.test.ts` | `SIGKILL` between `tmp/epoch-N/` write and `swapHead` leaves `head.json` pointing at epoch N-1; tmp dir is reaped on next open. |
| `packages/prosa-bundle-v2/test/cold-rebuild.test.ts` | Cold rebuild reconstructs 4 RocksDB shards from Parquet + epoch manifests; `SIGKILL` mid-rebuild leaves `index/` untouched and `index-rebuild-*/` is deleted on next open. |
| `packages/prosa-bundle-v2/test/canonical-merkle.test.ts` | `bundleRoot` and `rawSourceRoot` match the canonical encoding rules; reordering input rows produces the same root (sort happens before hash). |

## Gate

The lane is complete when:

1. All test files above pass under `pnpm test --filter @prosa/bundle-v2`.
2. A scripted scenario at `packages/prosa-bundle-v2/test/e2e/synthetic-bundle.test.ts` initializes a bundle, writes 1,000 synthetic sessions + 100,000 raw records + 200,000 objects via shard-actor commands across 8 concurrent worker tasks, seals one epoch, and re-opens the bundle. Counts match. `head.json` references the new epoch.
3. The cold-rebuild scenario at `packages/prosa-bundle-v2/test/e2e/cold-rebuild.test.ts` deletes `index/`, runs `prosa bundle rebuild-index`, verifies the rebuilt shards contain exactly the expected source-state and object-state entries.
4. **Invariants I1 and I4 pass.** I2 (idempotency) and I3 (canonical graph) require Lane 2. I5 (signed receipts) requires Lane 4.
5. No code in `apps/cli` or `apps/api` imports from `prosa-bundle-v2` yet.

## Risks

| Risk | Mitigation |
|---|---|
| Shard actor serialization bottleneck | Bench writes throughput per shard at 4–16 concurrent producers. Target: ≥ 50k `PutIfAbsent`/s aggregate across 4 shards on an 8-core laptop. |
| zstd window log enforcement gets bypassed | CI fixture: a pack with `windowLog = 24` is rejected with `PACK_ZSTD_WINDOW_TOO_LARGE`. |
| Pack writer crash leaves orphan packs | GC sweeps `cas/packs/pack-*` not referenced by any committed epoch. Implemented as a startup check in `openBundle`. |
| `head.json` rename non-atomic on some filesystems | Use `fs.rename` (POSIX atomic on same filesystem); document that bundle path must not span filesystems. Test on tmpfs + APFS + ext4. |
| Cold rebuild storage explosion | `rebuild.manifest` includes target size estimate; abort if free disk < 2× estimate. |

## Unblocks

Lane 2 (`03-lane-2-importers.md`) — needs the shard-actor API + pack writers + epoch lifecycle to ingest from providers.
