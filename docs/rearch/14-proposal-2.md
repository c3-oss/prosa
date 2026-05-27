Agreed with the review. The architectural skeleton remains correct, but the spec needs a binding v2.0.1 closeout before DDL, pack formats, or protocol structs are frozen.

Below is the revised closeout. I am treating each answer as a design decision, not an open option.

## v2.0.1 design closeout

The retained architecture is: local segment-log bundle, sharded KV uniqueness indexes, sharded pack writers, immutable raw/source/CAS packs, Parquet/Arrow projection segments, Tantivy search, log-shipping promotion, pack-level remote storage, receipt-pinned reads, Postgres control plane, ClickHouse OLAP, and remote search workers.

The correction is that **the segment log is not “one source file emits one final graph frame.”** It is now:

```text
source discovery
  -> raw source preservation
  -> provider-specific logical assembly
  -> deterministic merge / late-resolution layer
  -> canonical graph segment emit
  -> derived session blobs / search docs / analytics segments
  -> epoch seal
```

That change closes the Codex, Hermes, and Parquet immutability holes.

The current constraints still justify the skeleton: SQLite’s single WAL writer and long-transaction WAL-frame walking dominate compile today, while sync is dominated by per-batch object-store HEAD waves and a repeated plan→upload→commit→verify cycle.   The redesign still must preserve raw bytes, idempotent re-imports, canonical graph unification, content-addressed dedupe, and signed promotion receipts.

---

## 1. Late-bound projection columns: parent sessions and other post-pass fields

Decision: **resolve late-bound fields in a deterministic post-assembly pass before base projection segments are sealed, and use append-only fix-up segments only for cross-epoch corrections.**

Codex currently emits subagent edges and then runs a global `UPDATE sessions SET parent_session_id = ...` after all files commit; this exists because a parent session can live in a different source file.  Parquet cannot support that update in place, so v2 uses a two-layer rule:

During a normal epoch, import workers emit `SessionDraft` rows and `EdgeV2` rows. Before `sessions.parquet` is written, the `GraphResolver` builds:

```ts
type LateBindingIndex = {
  sessionsSeenThisEpoch: Set<SessionId>
  sessionsSeenPriorEpochs: RocksLookup<SessionId>
  spawnedEdges: Array<EdgeV2 & { edge_type: 'spawned'; dst_type: 'session' }>
}
```

Then it sets:

```ts
session.parent_session_id =
  first spawned edge where edge.dst_id == session.session_id
  and parent exists in this epoch or prior committed epochs
```

So ordinary Codex subagent linking lands directly in `SessionV2.parent_session_id` before the immutable Parquet row group is emitted.

For rare cases where a later epoch discovers a parent edge for an already sealed session, v2 writes a fix-up segment:

```ts
type SessionFixupV2 = {
  fixup_id: string
  target_session_id: string
  parent_session_id?: string | null
  timeline_confidence?: 'high' | 'medium' | 'low'
  title?: string | null
  summary?: string | null
  reason: 'late_parent_edge' | 'richer_metadata' | 'provider_reprojection'
  source_edge_id?: string
  raw_record_id?: string
  epoch: number
}
```

Read materialization applies fix-ups by `(target_session_id, epoch, fixup_id)` order. ClickHouse stores fix-ups in a separate `session_fixups` table and exposes a view that coalesces base session rows with the latest fix-up. Postgres hot cache stores the already-resolved value. The `edges` segment remains the authority; `parent_session_id` is a denormalized convenience.

---

## 2. RocksDB shard key and atomic uniqueness

Decision: **all uniqueness keys are owned by one deterministic shard, and all writes to that key are serialized by that shard’s actor. No “check on shard K, write on shard J” race is allowed.**

Shard function:

```ts
function shardForKey(keyspace: string, canonicalKey: Uint8Array): number {
  return firstU64LE(blake3(keyspace + '\0' + canonicalKey)) % 16
}
```

Every natural key has a canonical byte encoding:

```ts
source_file_key = cbor(['source_file', source_tool, path, size_bytes, mtime_ns, content_hash])
raw_record_key  = cbor(['raw_record', source_file_id, ordinal, raw_object_id])
object_key      = cbor(['object', object_id])
session_key     = cbor(['session', source_tool, source_session_id])
message_key     = cbor(['message', source_tool, source_session_id, source_message_id ?? ordinal])
edge_key        = cbor(['edge', src_type, src_id, dst_type, dst_id, edge_type])
```

The owning shard is the only process allowed to create or reserve that key. Each shard has a single writer actor, but there are 16 independent actors. Import workers never directly mutate RocksDB; they submit `PutIfAbsent`, `Reserve`, or `CommitReservation` commands to the owner shard.

Entity IDs are deterministic from the same canonical key, so uniqueness and entity identity do not split across shards. For example:

```ts
session_id = 'ses_' + base32(blake3(session_key))
```

That removes the need for a cross-shard transaction for canonical entities. If a worker tries to emit the same session twice, both requests route to the same shard actor; the second receives the existing ID and does not produce a new row.

Foreign keys are validated at epoch seal, not through RocksDB transactions. The graph resolver checks that every `message.session_id`, `tool_call.session_id`, and `edge.src/dst` references either an entity in the same epoch or an entity visible in prior committed epoch indexes. Invalid rows become `ImportErrorV2` or `UncertaintyV2`, not silently emitted.

---

## 3. Hermes dual-source session merging

Decision: **`ImportFrame` is replaced by `LogicalImportUnit`; it is not 1:1 with a physical source file.**

Hermes currently reads both `~/.hermes/state.db` and `~/.hermes/sessions/*.jsonl`; if the transcript file has more messages than the SQLite row, the file wins.  V2 makes that explicit.

```ts
type LogicalImportUnit = {
  unit_id: string
  source_tool: SourceTool
  logical_kind: 'session' | 'artifact' | 'project' | 'source_only'
  source_file_ids: string[]
  raw_record_ids: string[]
  projection: CanonicalProjectionDraft
  merge: {
    merge_strategy:
      | 'single_source'
      | 'hermes_sqlite_plus_jsonl'
      | 'gemini_session_versions'
      | 'provider_specific'
    selected_source_file_id?: string
    candidates?: Array<{
      source_file_id: string
      source_kind: string
      message_count?: number
      confidence: 'high' | 'medium' | 'low'
    }>
  }
}
```

Hermes importer flow:

```text
preserve state.db raw bytes
preserve every sessions/*.jsonl raw byte file
read state.db candidates
read JSONL transcript candidates
group by source_session_id
choose transcript body by max(message_count)
merge richer metadata from state.db when available
emit one LogicalImportUnit per logical Hermes session
```

Tie-breaker:

1. Higher message count wins transcript body.
2. If message counts tie, JSONL wins message ordering, SQLite wins metadata.
3. Hidden reasoning remains `visibility='hidden_by_default'`, not indexed and not exported by default, preserving the current Hermes rule.

This same logical-unit model also handles Gemini duplicate session versions.

---

## 4. Pack writer contention

Decision: **pack writers are sharded, not global.**

There is no `N importers → 1 CAS pack writer` funnel. That would recreate the WAL bottleneck in a new costume.

Local writers:

```text
8 CAS small-object pack writers        shard = blake3(object_id) % 8
2 CAS large-object writers             objects >= 32 MiB, standalone
4 raw-source pack writers              shard = blake3(source_file_id) % 4
1 graph segment writer per entity type batched Arrow writer
1 session-blob page writer pool        4 workers
1 Tantivy writer generation            fed by bounded batches
```

CAS pack writers accumulate objects until one of these triggers fires:

```ts
target_pack_bytes = 64 MiB
max_pack_bytes    = 128 MiB
max_objects       = 65_536
max_open_ms       = 2_000
```

Each writer owns its own temp file and zstd context. The epoch manifest simply references many packs:

```ts
cas_packs: PackRef[]
raw_source_packs: RawSourcePackRef[]
```

So the manifest gets more complex, but the hot path stops contending on one append mutex. On a normal 8-core laptop, the intended steady state is 6–8 import workers plus 8 CAS pack queues, with backpressure when total queued bytes exceed 512 MiB.

---

## 5. Server streaming validation memory budget

Decision: **validation is streaming; decompressed bytes are never accumulated.**

The API validates a pack like this:

```text
incoming request body
  -> bounded reader
  -> BLAKE3 pack hasher
  -> stored-slice BLAKE3 hasher
  -> zstd streaming decoder
  -> uncompressed BLAKE3 hasher
  -> discard decoded bytes
  -> S3 multipart upload of stored pack bytes
```

The object store receives the stored pack bytes, not the decompressed bytes. Decompressed bytes exist only as a streaming decoder buffer.

Hard limits:

```ts
maxObjectPackBytes = 128 MiB
defaultObjectPackBytes = 64 MiB
maxZstdWindowBytes = 8 MiB
perUploadReadBuffer = 512 KiB
perUploadS3PartBuffer = 8 MiB
perUploadWorstCaseUserlandMemory ≈ 12–16 MiB
maxConcurrentPackValidationsPerApiWorker = 4
```

So a 128 MiB pack with a 10× decompression ratio still uses about 16 MiB of process memory, not 1.28 GiB. At the default four validations per API worker, the validation memory budget is roughly 64 MiB plus runtime overhead.

S3 multipart checksums are used for transport integrity, but **BLAKE3 remains the authority**. The server computes `packDigest`, each entry’s `storedHash`, and each entry’s uncompressed hash. S3 ETags are not trusted as content identity.

If validation fails after multipart upload has started, the server aborts the multipart upload and does not insert pack catalog rows. If the response is lost after success, retry observes the pack digest already cataloged.

---

## 6. Multi-machine same-tenant union view

Decision: **authority remains per store, but tenant-wide reads use a materialized current-union table.**

The current product exists partly so multiple machines can promote into one tenant and read remotely.  V2 keeps per-store receipts but adds a tenant-current layer.

Postgres control tables:

```sql
CREATE TABLE tenant_store_authority (
  tenant_id text NOT NULL,
  store_id text NOT NULL,
  current_receipt_id text NOT NULL,
  current_bundle_root text NOT NULL,
  promoted_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, store_id)
);

CREATE TABLE tenant_session_current (
  tenant_id text NOT NULL,
  global_session_key text NOT NULL,
  store_id text NOT NULL,
  receipt_id text NOT NULL,
  session_id text NOT NULL,
  source_tool text NOT NULL,
  source_session_id text NOT NULL,
  project_id text,
  title text,
  start_ts timestamptz,
  end_ts timestamptz,
  message_count integer,
  tool_call_count integer,
  error_count integer,
  timeline_confidence text,
  sort_ts timestamptz,
  version bigint NOT NULL,
  PRIMARY KEY (tenant_id, global_session_key)
);
```

`global_session_key` is:

```ts
global_session_key = blake3(source_tool + '\0' + source_session_id)
```

Conflict rule when two stores contain the same logical session:

1. Higher `end_ts` wins.
2. If tied, higher `message_count` wins.
3. If tied, newer `receipt.issued_at` wins.
4. If tied, lexicographically smaller `store_id` wins.

Remote “all sessions for tenant” reads hit `tenant_session_current`, not a full ClickHouse partition scan. ClickHouse still stores per-store projection rows, but tenant-wide analytics join against a small replicated `current_receipts` dictionary or a materialized `current` flag.

Search follows the same rule: remote Tantivy indexes include `tenant_id`, `store_id`, `receipt_id`, and `global_session_key`; tenant-wide search filters to the current receipt set.

---

## 7. Device key history and rotation

Decision: **device public keys are append-only, receipt verification uses `device_key_id`, and old keys are never deleted.**

New tables:

```sql
CREATE TABLE device_public_key (
  tenant_id text NOT NULL,
  device_id text NOT NULL,
  key_id text NOT NULL,
  alg text NOT NULL DEFAULT 'Ed25519',
  public_key bytea NOT NULL,
  created_at timestamptz NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  revoked_at timestamptz,
  superseded_by_key_id text,
  registration_receipt jsonb,
  PRIMARY KEY (tenant_id, device_id, key_id)
);

CREATE TABLE receipt_signature_audit (
  receipt_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  device_id text NOT NULL,
  device_key_id text,
  client_signature bytea,
  server_key_id text NOT NULL,
  server_signature bytea NOT NULL,
  verified_at timestamptz NOT NULL
);
```

Receipt payload stores:

```ts
device: {
  deviceId: string
  keyId?: string
  publicKeyDigest?: string
}
clientSignature?: string
clientSignatureStatus: 'verified' | 'absent_v2_0' | 'invalid_rejected'
```

For v2.0, server signatures are mandatory. Device signatures are mandatory for newly registered v2 devices, but the protocol can accept `clientSignatureStatus='absent_v2_0'` for migration and bootstrap. Rotation inserts a new key row. If the old key is available, it cross-signs the new key. If not, account auth plus server-side device registration creates a new key without invalidating old receipts.

---

## 8. `MissingObjectPlan` canonical ordering

Decision: **bitmap/range positions are over BLAKE3-hex ascending object inventory order.**

The object inventory segment is sorted by:

```text
hash_alg ASC, hash_hex ASC, uncompressed_size ASC, compression ASC
```

For normal v2, `hash_alg` is always `blake3`, so this is effectively BLAKE3 hex ascending.

```ts
type ObjectInventoryEntryV2 = {
  index: number
  object_id: string
  hash_alg: 'blake3'
  hash_hex: string
  uncompressed_size: number
  compression: 'zstd' | 'none'
  stored_hash?: string
}
```

`objectSetRoot` is the Merkle root over this sorted inventory. `MissingObjectPlan` bitmaps and ranges refer to `index`. If the server does not have the inventory segment for a new `objectSetRoot`, `BeginPromotion` returns:

```ts
{ status: 'needs_inventory', uploadTarget: ... }
```

Only after the inventory is known can the server return a bitmap/range missing plan. That makes the encoding implementable by two independent teams.

---

## 9. `tenant_object` versus `tenant_pack`

Decision: **v2 removes row-per-object tenant grants. The access unit is receipt-scoped pack membership, not `tenant_object`.**

The current server uses `tenant_object` as a per-tenant access grant table.  That does not scale to billions of `(tenant_id, object_id)` rows. V2 stores global object locations but grants access by receipt and pack:

```sql
CREATE TABLE remote_pack (
  pack_digest text PRIMARY KEY,
  storage_key text NOT NULL,
  byte_length bigint NOT NULL,
  object_count integer NOT NULL,
  pack_header_digest text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE remote_pack_entry (
  pack_digest text NOT NULL,
  object_id text NOT NULL,
  offset bigint NOT NULL,
  stored_length bigint NOT NULL,
  uncompressed_size bigint NOT NULL,
  stored_hash text NOT NULL,
  uncompressed_hash text NOT NULL,
  PRIMARY KEY (pack_digest, object_id)
);

CREATE TABLE receipt_pack_grant (
  tenant_id text NOT NULL,
  receipt_id text NOT NULL,
  pack_digest text NOT NULL,
  object_filter_root text NOT NULL,
  grant_mode text NOT NULL CHECK (grant_mode IN ('all_entries','filtered_entries')),
  PRIMARY KEY (tenant_id, receipt_id, pack_digest)
);
```

Reads authorize by receipt:

```text
Does receipt R for tenant T include object O?
  -> check receipt objectSetRoot / object manifest proof
  -> find pack entry for O
  -> check receipt_pack_grant for pack_digest
  -> if grant_mode=all_entries, signed URL to pack is allowed
  -> if grant_mode=filtered_entries, API slices the object and never exposes full pack URL
```

This keeps content-addressed global dedupe while avoiding `tenant_object` row explosion. It also prevents cross-tenant pack leakage.

---

## 10. CLI receipt refresh policy

Decision: **refresh on read-command startup with TTL, and fail/redirect on mid-command 412. No indefinite stale local reads.**

Local config stores:

```ts
type CachedAuthority = {
  tenantId: string
  storeId: string
  receiptId: string
  bundleRoot: string
  serverUrl: string
  checkedAt: string
  expiresAt: string
}
```

Default policy:

```text
interactive CLI read: refresh if checkedAt older than 60 seconds
--refresh: always refresh
--offline or --local: never refresh; print stale warning if a cached remote receipt exists
MCP startup: refresh once, then pin
long-running TUI: refresh on explicit user action or server 412
```

Refresh call:

```http
GET /v2/stores/{storeId}/authority?knownReceiptId=...
```

Responses:

```ts
type AuthorityRefreshResponse =
  | { status: 'unchanged'; receiptId: string; expiresAt: string }
  | { status: 'updated'; receipt: PromotionReceiptV2; expiresAt: string }
  | { status: 'gone_or_forbidden' }
```

If a read request is made with a stale receipt and the server returns HTTP 412, the CLI refreshes once and retries if the read can be safely repeated. If the command is streaming output, it stops with:

```text
Remote authority changed from <old> to <new>. Re-run the command to read the new snapshot.
```

---

## 11. `session_blob_pack` schema

Decision: **transcripts are pre-shaped into paged session blobs at epoch seal and promotion seal.**

The current transcript path is expensive because it does six SQL passes per page, derives ordinal through `row_number()`, and fetches CAS bodies in a second round-trip for blocks over 8 KiB.  V2 makes the transcript a first-class derived artifact.

Pack file:

```ts
type SessionBlobPackV2 = {
  magic: 'PROSA_SESSION_BLOB_PACK_V2'
  header_len: number
  header_hash: string
  header: SessionBlobPackHeaderV2
  payload: Uint8Array
}
```

Header:

```ts
type SessionBlobPackHeaderV2 = {
  pack_digest: string
  compression: 'zstd'
  receipt_id?: string
  epoch: number
  page_count: number
  pages: SessionBlobPageRefV2[]
}

type SessionBlobPageRefV2 = {
  page_id: string
  session_id: string
  page_index: number
  message_ordinal_start: number
  message_ordinal_end: number
  message_count: number
  turn_count: number
  tool_call_count: number
  offset: number
  stored_length: number
  uncompressed_length: number
  stored_hash: string
  uncompressed_hash: string
}
```

Page payload:

```ts
type SessionTranscriptPageV2 = {
  schema: 'prosa.session-transcript-page.v2'
  session: SessionHeaderV2
  page: {
    page_index: number
    has_previous: boolean
    has_next: boolean
    next_cursor?: string
    previous_cursor?: string
  }
  counts: {
    message_count: number
    tool_call_count: number
    tool_result_count: number
    error_count: number
    artifact_count: number
  }
  messages: TranscriptMessageV2[]
  tool_calls_by_turn: Record<string, TranscriptToolCallV2[]>
  artifacts: TranscriptArtifactRefV2[]
}
```

Inline policy:

```ts
max_inline_block_bytes = 32 KiB
target_page_uncompressed_bytes = 512 KiB
max_page_uncompressed_bytes = 1 MiB
target_messages_per_page = 128
hard_messages_per_page = 256
```

Content block body:

```ts
type TranscriptTextBodyV2 =
  | { kind: 'inline'; text: string; byte_length: number }
  | {
      kind: 'cas_ref'
      object_id: string
      byte_length: number
      preview: string
      mime_type?: string
    }
```

Denormalized inline:

* session header
* messages
* content block metadata
* tool calls for the page’s turns
* latest matching tool result summaries
* artifact references

Not denormalized inline:

* large stdout/stderr/output bodies
* artifact binary bodies
* large extracted text over 32 KiB

Large sessions with 5,000+ turns become many pages. Cursor is `{session_id, page_index, receipt_id}` encoded and signed. Local and remote use the same blob schema.

---

## 12. Cold no-op compile target after RocksDB loss

Decision: **the <5 s no-op target applies to warm, healthy indexes. Cold repair has a separate target.**

Warm no-op compile:

```text
0.5–2.5 s target
parallel stat + source-state lookup
no parse, no hash, no derived rebuild
```

Cold repair after RocksDB loss:

```text
reference 1.4 GB workload: 20–90 s target
5 GB bundle: 2–6 min target
```

That is acceptable because cold repair is disaster recovery, not normal no-op re-import. The system should report it honestly:

```text
source-state index missing; rebuilding from committed epoch manifests
this is a repair path, not a normal no-op compile
```

After repair, the next no-op returns to the warm target.

---

## 13. Background audit

Decision: **a separate audit worker owns it; failed audit degrades receipts and triggers repair, not silent trust.**

Owner:

```text
prosa-audit-worker
```

Cadence:

```text
on pack ingest: validate BLAKE3 immediately
hourly: sample 0.1% of packs per tenant, metadata + byte-range check
daily: sample 1% of packs globally, full pack hash
weekly: full header scan of all packs
monthly: full byte rehash for cold packs, throttled by storage budget
```

Audit state:

```sql
CREATE TABLE pack_audit_state (
  pack_digest text PRIMARY KEY,
  last_header_check_at timestamptz,
  last_full_hash_at timestamptz,
  status text NOT NULL CHECK (status IN ('ok','missing','hash_mismatch','quarantined')),
  error jsonb
);

CREATE TABLE receipt_audit_state (
  receipt_id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('ok','degraded','invalidated')),
  affected_pack_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL
);
```

Drift response:

* Missing pack: mark pack `quarantined`, mark affected receipts `degraded`, alert operator, reads of affected object bodies return `503 DATA_UNAVAILABLE`, and server requests client re-promotion if any device with the receipt appears.
* Hash mismatch: same, but severity higher; pack is never served.
* Projection/count mismatch: mark receipt `degraded`; rebuild from promotion segments if possible.
* Receipt signature mismatch: mark `invalidated`; read API refuses that receipt.

The signed receipt still proves what the server accepted. Audit status proves whether the server still has it.

---

## 14. MCP `--authority auto`

Decision: **MCP pins `ReadContext` at server startup. It does not re-evaluate authority per tool call.**

Startup:

```text
prosa mcp serve --authority auto
  -> refresh receipt once unless --offline
  -> choose local or remote
  -> pin {tenant_id, store_id, receipt_id, bundle_root}
  -> every MCP tool in that process uses that context
```

Refresh happens only on:

* process restart
* explicit MCP tool: `prosa.refresh_authority`
* server 412 response
* user-driven `prosa sync status --refresh`

If 412 happens mid-agent turn, MCP returns:

```json
{
  "error": "AUTHORITY_CHANGED",
  "oldReceiptId": "...",
  "newReceiptId": "...",
  "instruction": "Restart or call prosa.refresh_authority to pin a new snapshot."
}
```

This avoids one agent turn seeing `search` from receipt A and `sessions` from receipt B. The current MCP is local-only, so this is a real v2 behavior change.

---

## 15. Remote Tantivy topology

Decision: **use a separate stateful Tantivy search fleet with Postgres generation pointers. Do not pretend Tantivy has aliases.**

Components:

```text
API workers
  -> search-router
  -> Tantivy workers with local NVMe/EBS generation directories
  -> Postgres search_generation pointer table
```

Tables:

```sql
CREATE TABLE search_generation (
  tenant_id text NOT NULL,
  store_id text,
  receipt_id text NOT NULL,
  generation_id text NOT NULL,
  index_root text NOT NULL,
  doc_count bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('building','ready','failed','retired')),
  created_at timestamptz NOT NULL,
  ready_at timestamptz,
  PRIMARY KEY (tenant_id, receipt_id)
);

CREATE TABLE search_generation_current (
  tenant_id text NOT NULL,
  store_id text,
  receipt_id text NOT NULL,
  generation_id text NOT NULL,
  PRIMARY KEY (tenant_id, store_id)
);
```

Promotion seal flow:

```text
build generation in generation_id.tmp
validate doc_count and searchRoot
fsync generation
mark search_generation.status='ready'
in same authority transaction, set search_generation_current
notify search workers via Postgres LISTEN/NOTIFY or queue
```

Read flow:

```text
API receives ReadContext(receipt_id)
API asks search-router for receipt_id
if worker has generation -> query
if worker is loading generation -> short retry
if generation unavailable -> 503 SEARCH_GENERATION_NOT_READY
never query an older generation for a newer receipt
```

For tenant-wide search, the router searches the current generation set for that tenant’s stores and merges top-k.

---

## 16. Incremental Parquet compaction policy

Decision: **compact derived Parquet segments by logical root without changing raw/projection authority.**

Compaction triggers per entity type:

```text
epoch file count > 32
or small-file count > 16 and total small-file bytes < 256 MiB
or deleted/superseded row ratio > 20%
or manual: prosa maintenance compact
```

Cadence:

```text
local: after compile if trigger hit and machine is idle, otherwise next maintenance
remote: after successful promotion, background worker compacts ClickHouse/Parquet sidecars
```

Important rule: the receipt’s logical roots are over rows, not over the physical Parquet file layout. Physical compaction does not change `projectionRoot`, `analyticsRoot`, or `bundleRoot` if the row set is identical.

Compaction writes:

```text
epochs/compact-<n>/
  sessions.compacted.parquet
  messages.compacted.parquet
  ...
  compact.manifest.cbor
```

Then `head.json` can reference compacted physical files while retaining the same logical roots. No-op compile does not trigger compaction synchronously; that protects deterministic no-op latency.

---

## 17. CLI surface mapping

Decision: **new `prosa read *` is the canonical surface; old commands map 1:1 during documentation/cutover.**

No compatibility shim is required long-term, but the user-facing capabilities must survive.

| Current command                             | V2 canonical command                                                |        |         |           |                                 |
| ------------------------------------------- | ------------------------------------------------------------------- | ------ | ------- | --------- | ------------------------------- |
| `prosa sessions list`                       | `prosa read sessions [filters]`                                     |        |         |           |                                 |
| `prosa sessions count`                      | `prosa read sessions --count [filters]`                             |        |         |           |                                 |
| `prosa session show <id> --format markdown` | `prosa read transcript <id> --format markdown`                      |        |         |           |                                 |
| `prosa session show <id> --json`            | `prosa read transcript <id> --json`                                 |        |         |           |                                 |
| `prosa search <query>`                      | `prosa read search <query>`                                         |        |         |           |                                 |
| `prosa query duckdb '<sql>'`                | `prosa read query '<sql>' --engine duckdb`                          |        |         |           |                                 |
| `prosa analytics sessions                   | tools                                                               | errors | models  | projects` | `prosa read analytics <report>` |
| `prosa export session <id>`                 | `prosa read transcript <id> --format markdown --output <path>`      |        |         |           |                                 |
| `prosa export parquet`                      | `prosa read export parquet`                                         |        |         |           |                                 |
| `prosa mcp serve`                           | `prosa mcp serve --authority auto                                   | local  | remote` |           |                                 |
| `prosa tui`                                 | `prosa read tui` or retained as `prosa tui` backed by `ReadContext` |        |         |           |                                 |

The analytics view names and projected columns remain a stable dashboard contract even if the underlying physical tables change.

---

# Concrete canonical schema carried by `LogicalImportUnit.projection`

This is the v2 projection schema. It intentionally mirrors the current canonical grain: projects, sessions, turns, events, messages, content blocks, tool calls, tool results, artifacts, edges, and search docs. The current schema already defines the key field set and role/tool/edge semantics.

```ts
type SourceTool = 'codex' | 'claude' | 'cursor' | 'gemini' | 'hermes'
type Confidence = 'high' | 'medium' | 'low'
type Visibility = 'default' | 'hidden_by_default' | 'audit_only'

type ProjectV2 = {
  project_id: string
  canonical_path: string | null
  path_hash: string | null
  source_tool: SourceTool | null
  source_project_id: string | null
  display_name: string | null
  created_at: string
}

type SessionV2 = {
  session_id: string
  source_tool: SourceTool
  source_session_id: string
  project_id: string | null
  parent_session_id: string | null
  parent_resolution: 'inline' | 'edge_derived' | 'fixup_derived' | 'unresolved'
  is_subagent: boolean
  agent_role: string | null
  agent_nickname: string | null
  title: string | null
  summary: string | null
  start_ts: string | null
  end_ts: string | null
  cwd_initial: string | null
  git_branch_initial: string | null
  model_first: string | null
  model_last: string | null
  status: string | null
  timeline_confidence: Confidence
  raw_record_id: string | null
}

type TurnV2 = {
  turn_id: string
  session_id: string
  source_turn_id: string | null
  ordinal: number
  start_ts: string | null
  end_ts: string | null
  model: string | null
  cwd: string | null
  git_branch: string | null
  approval_policy: string | null
  sandbox_policy: string | null
  effort: string | null
  raw_record_id: string | null
}

type EventV2 = {
  event_id: string
  session_id: string
  turn_id: string | null
  source_event_id: string | null
  event_type: string
  source_type: string | null
  subtype: string | null
  timestamp: string | null
  ordinal: number
  actor: 'user' | 'assistant' | 'tool' | 'system' | 'cli' | null
  payload_object_id: string | null
  raw_record_id: string
  confidence: Confidence
  is_derived: boolean
}

type MessageRole =
  | 'system_prompt'
  | 'developer'
  | 'user'
  | 'assistant'
  | 'tool'
  | 'operational'

type MessageV2 = {
  message_id: string
  session_id: string
  turn_id: string | null
  event_id: string | null
  source_message_id: string | null
  role: MessageRole
  author_name: string | null
  model: string | null
  timestamp: string | null
  ordinal: number
  parent_message_id: string | null
  request_id: string | null
  status: string | null
  raw_record_id: string
}

type ContentBlockV2 = {
  block_id: string
  message_id: string | null
  event_id: string | null
  session_id: string
  ordinal: number
  block_type: string
  text_object_id: string | null
  text_inline: string | null
  mime_type: string | null
  token_count: number | null
  is_error: boolean
  is_redacted: boolean
  visibility: Visibility
  raw_record_id: string
}

type ToolCallV2 = {
  tool_call_id: string
  session_id: string
  turn_id: string | null
  message_id: string | null
  event_id: string | null
  source_call_id: string | null
  tool_name: string
  canonical_tool_type: string | null
  args_object_id: string | null
  command: string | null
  cwd: string | null
  path: string | null
  query: string | null
  timestamp_start: string | null
  timestamp_end: string | null
  status: string | null
  raw_record_id: string
}

type ToolResultV2 = {
  tool_result_id: string
  tool_call_id: string | null
  session_id: string
  message_id: string | null
  event_id: string | null
  source_call_id: string | null
  status: string | null
  is_error: boolean
  exit_code: number | null
  duration_ms: number | null
  stdout_object_id: string | null
  stderr_object_id: string | null
  output_object_id: string | null
  preview: string | null
  raw_record_id: string
}

type ArtifactV2 = {
  artifact_id: string
  session_id: string | null
  project_id: string | null
  source_tool: SourceTool
  kind: string
  path: string | null
  logical_path: string | null
  object_id: string | null
  text_object_id: string | null
  mime_type: string | null
  size_bytes: number
  created_ts: string | null
  raw_record_id: string
}

type EdgeType =
  | 'parent_of'
  | 'calls'
  | 'returns'
  | 'spawned'
  | 'contains'
  | 'produced'
  | 'consumed'
  | 'derived_from'
  | 'summarizes'
  | 'compacts'
  | 'same_as'
  | 'refers_to'

type EdgeV2 = {
  edge_id: string
  src_type: string
  src_id: string
  dst_type: string
  dst_id: string
  edge_type: EdgeType
  confidence: Confidence
  source: 'explicit' | 'path_inferred' | 'timestamp_inferred' | 'content_inferred'
  raw_record_id: string | null
  metadata_object_id: string | null
}

type SearchDocV2 = {
  doc_id: string
  entity_type: string
  entity_id: string
  session_id: string | null
  project_id: string | null
  timestamp: string | null
  role: MessageRole | null
  tool_name: string | null
  canonical_tool_type: string | null
  field_kind:
    | 'message_text'
    | 'user_prompt'
    | 'assistant_text'
    | 'system_prompt'
    | 'command'
    | 'command_output_preview'
    | 'error'
    | 'file_path'
    | 'diff'
    | 'summary'
    | 'artifact_text'
    | 'tool_args'
    | 'tool_result'
  errors_only: boolean
  text: string
}
```

`timeline_confidence='low'` remains available for Cursor, where ordering depends on undecoded protobuf state.

---

# Raw source pack byte format

Decision: **raw source packs are indexed, entry-addressable, and retained as long as any epoch manifest references them.**

The current raw layer preserves source bytes under `raw/sources/<blake3>.zst`, and the raw layer is the rebuild source of truth.  V2 moves those bytes into indexed packs.

Byte layout:

```text
0      16 bytes   magic = "PROSA_RAW_SRC_V2"
16     u16le      version = 2
18     u16le      flags
20     u32le      header_len
24     32 bytes   header_blake3
56     N bytes    canonical CBOR RawSourcePackHeaderV2
56+N   M bytes    payload: concatenated stored entries
```

Header:

```ts
type RawSourcePackHeaderV2 = {
  pack_digest: string
  created_at: string
  compression_default: 'zstd'
  entry_count: number
  entries: RawSourcePackEntryV2[]
}

type RawSourcePackEntryV2 = {
  source_file_id: string
  source_tool: SourceTool
  path: string
  file_kind: string
  size_bytes: number
  mtime_ns: number | null
  content_hash: string
  object_id: string

  stored_offset: number
  stored_length: number
  compression: 'zstd' | 'none'
  uncompressed_hash: string
  uncompressed_size: number
  stored_hash: string

  workspace_hint?: string | null
}
```

Entries are sorted by `source_file_id`. `SourceState` in RocksDB stores:

```ts
type SourceStateV2 = {
  source_file_id: string
  source_tool: SourceTool
  path: string
  size_bytes: number
  mtime_ns: number | null
  content_hash: string
  object_id: string
  raw_source_location: {
    pack_digest: string
    stored_offset: number
    stored_length: number
    compression: 'zstd' | 'none'
  }
  last_seen_epoch: number
}
```

Random recovery of original source file X is O(1) metadata lookup plus O(entry length) decode. No pack scan.

Retention rule:

```text
A raw_source_pack MUST NOT be deleted while any committed epoch manifest references it.
Projection and derived segments are disposable. Raw source packs are not.
```

---

# Partial failure and GC

Local compile:

```text
tmp/epoch-N/
  packs being written
  graph segments being written
  indexes pending
```

Nothing becomes visible until `epoch.manifest.cbor` is fsynced and `head.json` atomically swaps.

GC rules:

* `tmp/epoch-*` older than 24 hours: delete.
* local packs not referenced by any committed epoch after two clean starts: delete.
* RocksDB entries tagged `pending_epoch` with no committed manifest: delete.
* session blobs/search generations not named by current `head.json`: delete after one successful rebuild.

Server staging:

```sql
promotion_staging(status='open'|'uploading'|'materializing'|'sealed'|'aborted')
```

Unsealed staging rows expire after 72 hours. Staged S3 objects live under:

```text
staging/<tenant>/<promotion_id>/...
```

Lifecycle deletes them after 7 days if no sealed receipt references them.

Readers are forbidden from honoring unfinished receipts. Only `receipt.status='sealed'` and `remote_authority.current_receipt_id = receipt_id` are readable.

---

# Revised protocol deltas

Only the deltas from proposal 1 matter here.

`BeginPromotion` now includes or references sorted inventories:

```ts
type BeginPromotionRequestV2 = {
  protocolVersion: 2
  tenantId: string
  storeId: string
  storePath: string
  head: BundleHeadV2
  inventories: {
    objectInventorySegment: SegmentRef
    projectionInventorySegment: SegmentRef
  }
  device: {
    deviceId: string
    keyId?: string
    publicKey?: string
  }
  clientSignature?: string
}
```

`BeginPromotionResponseV2` can ask for inventory first:

```ts
type BeginPromotionResponseV2 =
  | { status: 'already_promoted'; receipt: PromotionReceiptV2 }
  | { status: 'needs_inventory'; missingInventories: SegmentRef[]; promotionId: string }
  | { status: 'needs_upload'; promotionId: string; missingObjects: MissingObjectPlanV2; missingSegments: SegmentRef[] }
```

`MissingObjectPlanV2` is pinned to sorted inventory order:

```ts
type MissingObjectPlanV2 = {
  objectSetRoot: string
  inventoryDigest: string
  ordering: 'hash_alg_hash_hex_size_compression_ascending'
  encoding: 'none' | 'range_list' | 'roaring_bitmap_zstd'
  objectCount: number
  payloadBase64?: string
}
```

`SealPromotion` cannot expose partial materialization:

```ts
type SealPromotionResponseV2 =
  | { status: 'materializing'; promotionId: string }
  | { status: 'sealed'; receipt: PromotionReceiptV2 }
```

Read API rule:

```text
A materializing promotion is invisible.
The previous sealed receipt remains authoritative until the new receipt is sealed.
```

This directly removes the current batch-by-batch receipt churn, where each `verifyPromotion` writes a receipt and updates `remote_authority`.

---

# Revised performance envelope note

The original performance table still stands, with one explicit split added:

```text
warm no-op compile:          0.5–2.5 s
cold index-repair no-op:     20–90 s on the 1.4 GB reference workload
no-op sync:                  0.2–1.5 s
fresh sync:                  bandwidth-bound, plus server materialization
```

The reference workload remains the right sizing target: 1–5 GiB bundle, 1k–10k sessions, 500k–5M raw records, 500k–2M CAS objects, 100k–500k search docs, with median CAS objects around 1–4 KiB and long sessions up to 5,000 messages.

## Final recommendation

With these amendments, the design is implementable.

The three most important changes from proposal 1 are:

First, **`LogicalImportUnit` replaces file-shaped `ImportFrame`**. That closes Hermes merging and makes late-bound Codex parent resolution explicit.

Second, **all uniqueness keys are owned by deterministic shard actors**. That closes the RocksDB race introduced by splitting the store into 16 databases.

Third, **the server grants receipt-scoped pack access, not per-object tenant rows**. That keeps the pack model scalable without giving up tenant isolation.

At this point, I would let implementation begin only after the team turns the above into three frozen specs: `bundle-v2.md`, `promotion-protocol-v2.md`, and `read-api-v2.md`. The architecture is no longer the blocker; the remaining risk is implementers making different assumptions in different subsystems.
