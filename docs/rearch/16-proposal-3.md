Accepted. This review moves the design from “architecturally ready” to “spec-freeze ready, provided the remaining pins are written down.” The important thing now is not another architecture pass; it is preventing divergent implementation assumptions across bundle, promotion, and read surfaces.

The pins below are the final amendments I would put directly into `bundle-v2.md`, `promotion-protocol-v2.md`, and `read-api-v2.md`. They keep the design anchored to the five invariants: raw-byte preservation, idempotent re-imports, canonical cross-provider graph semantics, content-addressed dedupe, and signed promotion receipts.  They also preserve the core performance objective: remove the SQLite single-writer ceiling, eliminate per-batch HEAD verification, and pre-shape the expensive transcript path.

# Final spec-freeze amendments

## `bundle-v2.md`

### L1. `SessionFixupV2` fields

`SessionFixupV2` is expanded to cover all late-bound session fields that can affect read ordering, tenant union conflict resolution, or session display.

```ts
type SessionFixupV2 = {
  fixup_id: string
  target_session_id: string

  parent_session_id?: string | null
  parent_resolution?: 'inline' | 'edge_derived' | 'fixup_derived' | 'unresolved'

  timeline_confidence?: 'high' | 'medium' | 'low'
  title?: string | null
  summary?: string | null

  end_ts?: string | null
  model_last?: string | null

  reason:
    | 'late_parent_edge'
    | 'richer_metadata'
    | 'provider_reprojection'
    | 'late_summary'
    | 'late_session_extension'

  source_edge_id?: string | null
  raw_record_id?: string | null
  epoch: number
  created_at: string
}
```

Any fix-up that changes `end_ts`, `model_last`, `title`, `summary`, `timeline_confidence`, or `parent_session_id` must propagate into:

```text
local session hot cache
session_blob page headers
remote Postgres hot cache
tenant_session_current
ClickHouse session coalescing view
```

That is mandatory because `tenant_session_current` uses `end_ts` in its conflict rule. A fix-up that changes `end_ts` but does not refresh the tenant-current row is invalid.

### L2. Large-object pack assignment

Objects `>= 32 MiB` are stored as **single-entry standalone packs**.

They still use the same `PackRef[]` manifest array as small-object packs:

```ts
type PackRef = {
  pack_digest: string
  kind: 'cas_object_pack'
  entry_count: number
  byte_length: number
  object_set_root: string
  standalone_large_object: boolean
}
```

For large objects:

```ts
entry_count = 1
standalone_large_object = true
```

The “2 CAS large-object writers” are only concurrency limiters for read → compress/hash → fsync. They do not pool multiple large objects into a shared multi-entry pack.

### L3. Cold rebuild crash safety

Cold rebuild uses **scratch indexes plus atomic replacement**, not resumable partial rebuild.

Flow:

```text
index/
  shard-00.rocksdb/
  ...
  shard-15.rocksdb/

index-rebuild-<uuid>/
  shard-00.rocksdb/
  ...
  shard-15.rocksdb/
  rebuild.manifest.tmp
```

Rules:

1. A rebuild never writes into the live `index/shard-*` directories.
2. Rebuild writes into `index-rebuild-<uuid>/`.
3. On completion, it fsyncs every shard and writes `rebuild.manifest`.
4. It atomically renames the old `index/` to `index-old-<timestamp>/`.
5. It atomically renames `index-rebuild-<uuid>/` to `index/`.
6. On startup, any `index-rebuild-*` without a complete `rebuild.manifest` is deleted.
7. The next run restarts cold rebuild from scratch.

This costs some repeated work after `SIGKILL`, but it avoids a partially populated index ever becoming authoritative.

### L4. Per-logical-session `Reserve`

Every provider importer must reserve the logical session key before full parse, CAS staging, and projection assembly.

```ts
type ReserveSessionCommand = {
  op: 'Reserve'
  keyspace: 'session'
  canonicalKey: Uint8Array
  owner: {
    worker_id: string
    source_tool: SourceTool
    source_file_ids: string[]
  }
}
```

Importer flow:

```text
discover source file
  -> cheap identification pass
  -> derive source_session_id or logical session key
  -> Reserve(session_key) on owning shard actor
  -> only reservation winner performs full parse / merge / projection assembly
  -> losers attach their source file IDs as candidates or exit if already represented
```

For Hermes and Gemini, the identification pass may read a header, filename-derived session ID, SQLite row key, or JSON top-level session ID. It must not perform full transcript parsing before the reservation.

This avoids two workers doing redundant full parse/CAS work for the same logical session.

### L5. FK validation data structure at epoch seal

Epoch seal uses exact in-memory and mmap-backed ID membership structures, not per-row RocksDB lookups.

Data structures:

```ts
type EntityExistenceSet = {
  entity_type: CanonicalEntityType
  current_epoch_ids: HashSet<EntityId>        // exact
  prior_epoch_ids_mmap: SortedFixedKeyTable   // exact, full 32-byte digest keys
  optional_bloom_prefilter?: BloomFilter      // acceleration only, never authority
}
```

Rules:

1. Current-epoch entity IDs are held in exact hash sets.
2. Prior committed entity IDs are stored as mmap-backed sorted fixed-width key tables per entity type.
3. Validation checks current epoch set first, then binary-searches the mmap table.
4. Bloom filters may skip negative lookups, but a Bloom positive is never enough to accept a FK.
5. No validation path may perform one RocksDB lookup per row.

The expected working set for 1M current-epoch IDs is acceptable under the 4 GiB laptop memory budget. The exact mmap table preserves correctness without the 40–80 s random-lookup seal pass.

### L6. `workspace_hint` propagation

`workspace_hint` is not source-only. It is projected as provenance and used for project association.

Add to `SessionV2`:

```ts
workspace_hint: string | null
workspace_hint_source_file_id: string | null
project_resolution:
  | 'explicit_provider_project'
  | 'workspace_hint'
  | 'cwd_initial'
  | 'path_inferred'
  | 'unresolved'
```

Add to `ProjectV2`:

```ts
workspace_hint: string | null
canonical_path: string | null
path_hash: string | null
```

Rule:

```text
SourceFile.workspace_hint
  -> GraphResolver project association
  -> SessionV2.project_id
  -> SessionV2.workspace_hint for audit/debug
```

If a provider supplies a stronger project root, that wins. `workspace_hint` is retained as provenance even when it does not win.

## `promotion-protocol-v2.md`

### L7. Client-side zstd window cap

The zstd encoder window cap is mandatory on producers.

```ts
maxZstdWindowLog = 23
maxZstdWindowBytes = 8 * 1024 * 1024
```

Pack producers must encode every pack frame with:

```text
window_log <= 23
window_size <= 8 MiB
```

For the reference zstd CLI/library this corresponds to `--long=23` at most.

Server behavior:

```ts
if frame.window_size > 8 MiB:
  reject with PACK_ZSTD_WINDOW_TOO_LARGE
```

Error shape:

```ts
type PackValidationError = {
  code: 'PACK_ZSTD_WINDOW_TOO_LARGE'
  maxWindowBytes: 8388608
  actualWindowBytes: number
  action: 'reencode_pack'
}
```

The CLI must catch this error, re-encode the pack with the required window cap, and retry. This is a wire-format rule, not just a server tuning parameter.

### L8. `tenant_session_current` consistency model

`tenant_session_current` is updated in the **same Postgres transaction** as the authority swap.

Promotion seal order:

```text
1. Materialize ClickHouse rows.
2. Build and mark Tantivy generation ready.
3. Build Postgres hot-cache rows.
4. Prepare tenant_session_current upserts/deletes.
5. Open one Postgres transaction:
     - insert sealed receipt
     - update tenant_store_authority.current_receipt_id
     - upsert tenant_session_current rows
     - update search_generation_current
     - mark promotion sealed
6. Commit.
```

Read rule:

```text
Before commit: tenant reads see the previous receipt and previous tenant_session_current.
After commit: tenant reads see the new receipt and new tenant_session_current.
There is no async consistency window.
```

If step 5 fails, the new promotion remains invisible and the previous sealed receipt stays authoritative.

### L9. `clientSignatureStatus='absent_v2_0'` sunset

`absent_v2_0` is a permanent historical status for receipts minted before the device-signature requirement, but it cannot be minted after v2.1 enforcement.

Rules:

```text
protocol v2.0:
  clientSignature may be absent during migration/bootstrap
  receipt records clientSignatureStatus='absent_v2_0'

protocol v2.1+:
  clientSignature is mandatory for new promotions
  absent signature is rejected with CLIENT_SIGNATURE_REQUIRED

old v2.0 receipts:
  remain verifiable forever
  are not rewritten
  are not treated as invalid merely because device signatures became mandatory later
```

This gives audit stability without leaving the future behavior undecided.

### L10. Cross-tenant CAS dedupe and timing oracle

Decision: **no protocol-visible cross-tenant dedupe in v2.0. Dedup scope is tenant-local.**

Object IDs remain content-addressed BLAKE3 hashes, but remote pack catalogs are tenant-scoped:

```sql
CREATE TABLE remote_pack (
  tenant_id text NOT NULL,
  pack_digest text NOT NULL,
  storage_key text NOT NULL,
  ...
  PRIMARY KEY (tenant_id, pack_digest)
);

CREATE TABLE remote_pack_entry (
  tenant_id text NOT NULL,
  pack_digest text NOT NULL,
  object_id text NOT NULL,
  ...
  PRIMARY KEY (tenant_id, pack_digest, object_id)
);
```

`MissingObjectPlanV2` only checks objects already present for the same tenant. Tenant B never learns that tenant A has already uploaded the same object. The server may use opaque storage-layer dedupe below the application layer only if it does not alter protocol responses, timing behavior, grants, or audit surfaces.

This trades some storage efficiency for a cleaner privacy posture. Within one tenant, dedupe across stores and devices remains fully enabled.

### L11. Pack GC ownership

Pack lifecycle GC is owned by a separate process:

```text
prosa-gc-worker
```

Not the API worker, and not the audit worker.

GC tables:

```sql
CREATE TABLE pack_gc_state (
  tenant_id text NOT NULL,
  pack_digest text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'live',
    'tombstone_pending',
    'delete_pending',
    'deleted',
    'blocked'
  )),
  first_unreferenced_at timestamptz,
  deleted_at timestamptz,
  error jsonb,
  PRIMARY KEY (tenant_id, pack_digest)
);
```

Deletion rule:

```text
A pack is GC-eligible only when:
  - no sealed receipt_pack_grant references it
  - no open/materializing promotion_staging row references it
  - no degraded receipt repair task references it
  - it has been unreferenced for at least 30 days
```

Deletion sequence:

```text
mark tombstone_pending
wait 24h
delete S3 object
delete remote_pack_entry rows
delete remote_pack row
mark deleted
```

Audit checks integrity. GC handles lifecycle. They are separate jobs with separate capacity budgets.

## `read-api-v2.md`

### L12. CLI cache-skip-network rule

The CLI may skip the authority refresh HTTP call while the cached authority is unexpired.

Rule:

```ts
if cachedAuthority.expiresAt > now
   and command does not pass --refresh
   and command is not a mutating sync/status command:
     use cached authority without network call
else:
     call GET /v2/stores/{storeId}/authority
```

Defaults:

```text
interactive read TTL: 60 s
MCP startup refresh: once
TUI refresh: startup + explicit user refresh
--refresh: always network
--offline / --local: never network
```

Within TTL, staleness is accepted by design. Receipt-pinning preserves internal consistency even if the user is reading a slightly old snapshot.

### L13. `SessionBlobPackV2` joint page constraint

The writer must enforce both constraints together:

```text
page_uncompressed_payload_bytes <= 1 MiB
AND
each inline content block <= 32 KiB
```

Writer algorithm:

```text
for each candidate block:
  if block_bytes > 32 KiB:
      emit cas_ref
  else if inlining block would push page payload > 1 MiB:
      emit cas_ref or start next page
  else:
      emit inline
```

A page may also split before the hard message count if the 1 MiB payload cap would be exceeded.

Effective constraints:

```ts
target_page_uncompressed_bytes = 512 * 1024
max_page_uncompressed_bytes = 1024 * 1024
target_messages_per_page = 128
hard_messages_per_page = 256
max_inline_block_bytes = 32 * 1024
```

The byte cap wins over message count.

### L14. Re-promotion trigger mechanism

Repair is discovered by pull through authority refresh.

`AuthorityRefreshResponse` gains:

```ts
type AuthorityRefreshResponse =
  | {
      status: 'unchanged'
      receiptId: string
      expiresAt: string
      auditStatus: 'ok' | 'degraded' | 'invalidated'
      repair?: RepairRequest
    }
  | {
      status: 'updated'
      receipt: PromotionReceiptV2
      expiresAt: string
      auditStatus: 'ok' | 'degraded' | 'invalidated'
      repair?: RepairRequest
    }

type RepairRequest = {
  kind: 're_promote_requested'
  reason:
    | 'missing_pack'
    | 'hash_mismatch'
    | 'projection_rebuild_failed'
    | 'search_generation_missing'
  affectedReceiptId: string
  affectedBundleRoot: string
  affectedPackDigests?: string[]
  message: string
}
```

Client behavior:

```text
on normal read:
  if repair.kind == re_promote_requested:
      print warning
      continue only if unaffected by missing data

on prosa sync status --refresh:
  show repair request

on prosa sync:
  if local bundleRoot matches affectedBundleRoot:
      re-upload missing packs / re-seal as repair promotion
```

No push notification is required for v2.0. The repair path is pull-discovered on next authority refresh or sync.

### L15. Merkle input shape for projection roots

Projection roots are over canonical row content, not Parquet bytes.

Per entity type:

```ts
leaf = blake3(
  'prosa.projection.leaf.v2' ||
  entity_type ||
  primary_key ||
  canonical_cbor(row_tuple)
)
```

Canonical row tuple rules:

```text
- Fields appear in schema order, not object/map iteration order.
- Null is encoded as canonical CBOR null.
- Integers are canonical CBOR integers.
- Strings are UTF-8 NFC-normalized.
- Timestamps are UTC RFC3339 with millisecond precision.
- Object IDs and entity IDs use canonical lowercase string form.
- Omitted optional fields are encoded as null.
```

Sort order:

```text
entity_type ASC by fixed enum order
then primary_key ASC bytewise
```

Tree construction:

```text
projectionRoot(entity_type) = binary Merkle root over sorted leaves
projectionRoot = binary Merkle root over entity-type roots in enum order
```

Physical Parquet compaction may change file bytes, row groups, and file count. It must not change `projectionRoot` if the canonical row set is identical.

### L16. `prosa tui` surface

Retain:

```text
prosa tui
```

Do not introduce `prosa read tui`.

`prosa tui` is backed by the same `ReadContext` resolver as `prosa read *`:

```text
prosa tui --authority auto|local|remote
prosa tui --refresh
prosa tui --offline
```

Reason: TUI is an application mode, not a read subcommand. Keeping it top-level avoids two diverging entry points.

### L17. Tantivy generation retirement

A search generation becomes retired when no current authority points at it and the retention window has passed.

Tables:

```sql
CREATE TABLE search_generation_ref (
  tenant_id text NOT NULL,
  generation_id text NOT NULL,
  receipt_id text NOT NULL,
  ref_kind text NOT NULL CHECK (ref_kind IN ('current','pinned_recent','repair')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  PRIMARY KEY (tenant_id, generation_id, receipt_id, ref_kind)
);
```

Rules:

```text
ready -> retired:
  when generation is not current for any store
  and has no repair reference
  and is older than 7 days
  and at least one newer ready generation exists for the same tenant/store

retired -> deleted:
  after 24h retirement grace
  once no API/search worker has the generation mmap/open
```

Worker behavior:

```text
search worker reloads generation pointers
drops query routing to retired generation
closes readers after in-flight queries finish
deletes local generation directory
reports deletion to Postgres
```

Retention guarantees:

```text
Keep current generation.
Keep previous generation for 7 days.
Keep repair-pinned generations until repair task closes.
Delete retired local NVMe/EBS directories after grace.
```

# Final gate statement

With these pins, the three specs can freeze.

The two operationally significant items are now hard requirements:

1. **Pack producers must enforce `zstd window <= 8 MiB`; the server rejects larger windows.**
2. **`tenant_session_current` updates in the same transaction as the receipt authority swap; no async consistency gap.**

The remaining items are now exact enough for independent implementation: cold rebuild is scratch-and-rename, logical sessions reserve before full parse, FK seal validation avoids per-row RocksDB lookups, cross-tenant CAS dedupe is intentionally not protocol-visible, repair is pull-discovered through authority refresh, projection Merkle roots hash canonical row tuples, `prosa tui` remains top-level, and Tantivy generations have bounded retention.

I would now freeze `bundle-v2.md`, `promotion-protocol-v2.md`, and `read-api-v2.md` with these amendments and begin implementation from those documents only.
