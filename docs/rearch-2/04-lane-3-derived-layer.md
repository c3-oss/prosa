# Lane 3 — Derived layer

## Goal

Ship the local derived artifacts that read paths consume: Tantivy full-text index (local only — Postgres FTS handles remote in Lane 4), `SessionBlobPackV2` paged transcript packs, and incremental DuckDB analytics views over Parquet segments. After this lane, `prosa search` and the v1-style transcript renderer work against bundle v2 with bounded p95 latency.

## Depends on

- Lane 2 (Importers) complete. This lane reads the canonical projection from `epochs/<n>/projection/*.parquet` and `search_docs.arrow.zst`.

## Deliverables

- New package `packages/prosa-derived-v2` containing:
  - Tantivy local index writer (incremental, generation-aware).
  - `SessionBlobPackV2` writer + reader with paged transcripts.
  - DuckDB analytics view definitions (5 fixed reports) keyed on the v2 Parquet layout.
- Updated CLI: `prosa index-v2 tantivy`, `prosa index-v2 status`, `prosa export-v2 parquet` (alongside v1).
- Compaction worker (basic): merges small Parquet epoch segments when an entity type has > 32 small files.

## Tasks

1. **Tantivy generation writer.** Port v1 `rebuildTantivyIndex` to bundle v2. Source corpus is `search_docs.arrow.zst` from the current epoch. Schema unchanged (raw token fields plus `text` with default tokenizer). Writer uses 300 MB heap, 4 threads. Index lives at `<bundle>/search/tantivy/`. Generation pointer in `search_index_status` table is updated post-rebuild.
2. **Tantivy incremental rebuild.** Same logic as v1: `last_indexed_rowid` + `schema_fingerprint` checkpoint. Full rebuild forced on schema fingerprint mismatch.
3. **`SessionBlobPackV2` writer.** For each session in the new epoch, build pages per the joint constraint from L13: page payload ≤ 1 MiB uncompressed, each inline content block ≤ 32 KiB, target 128 messages/page, hard 256/page, byte cap wins over message count. Inline blocks ≤ 32 KiB; larger ones get `cas_ref` with preview.
4. **`SessionBlobPackV2` reader.** `loadTranscriptPage(bundle, session_id, cursor) → SessionTranscriptPageV2`. Used by local CLI `prosa session show` and the MCP `sessions` tool.
5. **DuckDB analytics views.** Port the v1 `createAnalyticsViews` to read from the v2 Parquet layout. Five fixed reports (`session_facts`, `tool_usage_facts`, `error_facts`, `model_usage`, `project_activity`) — column shapes preserved as the stable contract.
6. **Incremental Parquet compaction.** Background worker (runs at end of compile if trigger fired) merges small epoch segments into a compacted file per entity type when:
   - File count > 32 for that entity type, OR
   - Small-file count > 16 AND total small-file bytes < 256 MiB.
   Compaction preserves the logical row set; `bundleRoot` does not change because the Merkle leaves are over canonical row content (Lane 0 rule). A `compact.manifest.cbor` records which epoch files are superseded.

## Concrete types and schemas

### `SessionBlobPackV2` (paged)

```ts
// packages/prosa-derived-v2/src/session-blob/types.ts
export type SessionBlobPackHeaderV2 = {
  pack_digest: string
  compression: 'zstd'
  epoch: number
  page_count: number
  pages: SessionBlobPageRefV2[]
}

export type SessionBlobPageRefV2 = {
  page_id: string
  session_id: string
  page_index: number
  message_ordinal_start: number
  message_ordinal_end: number
  message_count: number
  turn_count: number
  tool_call_count: number
  stored_offset: number
  stored_length: number
  uncompressed_length: number
  stored_hash: string
  uncompressed_hash: string
}

export type SessionTranscriptPageV2 = {
  schema: 'prosa.session-transcript-page.v2'
  session: SessionHeaderV2
  page: {
    page_index: number
    has_previous: boolean
    has_next: boolean
    next_cursor: string | null
    previous_cursor: string | null
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

export type TranscriptTextBodyV2 =
  | { kind: 'inline'; text: string; byte_length: number }
  | { kind: 'cas_ref'; object_id: string; byte_length: number; preview: string; mime_type?: string }
```

### Writer joint constraint (lean profile)

```ts
// packages/prosa-derived-v2/src/session-blob/writer.ts
const MAX_PAGE_UNCOMPRESSED_BYTES = 1024 * 1024     // 1 MiB
const TARGET_PAGE_UNCOMPRESSED_BYTES = 512 * 1024
const TARGET_MESSAGES_PER_PAGE = 128
const HARD_MESSAGES_PER_PAGE = 256
const MAX_INLINE_BLOCK_BYTES = 32 * 1024

export function appendBlock(page: PageBuilder, block: ContentBlockV2): PageDecision {
  const blockBytes = blockSizeBytes(block)
  if (blockBytes > MAX_INLINE_BLOCK_BYTES) {
    return { kind: 'cas_ref' }
  }
  if (page.currentBytes + blockBytes > MAX_PAGE_UNCOMPRESSED_BYTES) {
    if (page.messageCount === 0) {
      // Page would have zero messages; force CAS ref instead.
      return { kind: 'cas_ref' }
    }
    return { kind: 'split_page' }
  }
  return { kind: 'inline' }
}
```

### Analytics view definitions

Same as v1 (`packages/prosa-core/src/services/export/parquet.ts::createAnalyticsViews`), ported to read from `epochs/<latest>/projection/*.parquet`. The compaction layer is transparent to view definitions: views read `read_parquet('epochs/*/projection/<table>.parquet')` plus any `epochs/compact-*/<table>.compacted.parquet`.

```sql
-- packages/prosa-derived-v2/src/analytics/views.sql

CREATE OR REPLACE VIEW session_facts AS
SELECT
  s.session_id,
  s.source_tool,
  s.project_id,
  p.display_name AS project_name,
  s.source_session_id,
  s.start_ts,
  s.end_ts,
  DATE_DIFF('second', s.start_ts::TIMESTAMP, s.end_ts::TIMESTAMP) AS duration_seconds,
  s.model_first,
  s.model_last,
  -- ... (same shape as v1)
FROM sessions s
LEFT JOIN projects p ON p.project_id = s.project_id
LEFT JOIN (...) ...
```

(All five view bodies follow the v1 shape from `packages/prosa-core/src/core/schema/sql/003_analytics_views.ts`. They are not reproduced here in full; the lane PR carries them verbatim.)

### Compaction trigger

```ts
// packages/prosa-derived-v2/src/compaction/policy.ts
export function shouldCompact(entityType: CanonicalEntityType, segments: SegmentRef[]): boolean {
  const small = segments.filter((s) => s.byteLength < 32 * 1024 * 1024) // <32 MiB = small
  if (small.length > 32) return true
  if (small.length > 16 && small.reduce((sum, s) => sum + s.byteLength, 0) < 256 * 1024 * 1024) {
    return true
  }
  return false
}
```

## Tests

| File | Asserts |
|---|---|
| `packages/prosa-derived-v2/test/tantivy-rebuild.test.ts` | Incremental rebuild adds only new docs since `last_indexed_rowid`; schema fingerprint mismatch forces full rebuild. |
| `packages/prosa-derived-v2/test/session-blob-writer.test.ts` | Joint constraint enforced: 5,000-message session produces multiple pages; inline block > 32 KiB becomes `cas_ref`; page payload never exceeds 1 MiB. |
| `packages/prosa-derived-v2/test/session-blob-reader.test.ts` | `loadTranscriptPage` round-trips the writer output; cursors are stable across reopens. |
| `packages/prosa-derived-v2/test/analytics-views.test.ts` | All 5 view names + column shapes match v1 contract; queries against fixture return expected row counts. |
| `packages/prosa-derived-v2/test/compaction.test.ts` | Trigger fires when 33 small Parquet files exist; compacted file replaces them; `bundleRoot` unchanged (canonical leaves are over row content, not file bytes). |
| `packages/prosa-derived-v2/test/derived-rebuild-on-import.test.ts` | After Lane 2 emits a new epoch, derived layer rebuilds Tantivy + writes session blobs + emits Parquet, all referenced by the new epoch's manifest. |

## Gate

The lane is complete when:

1. All test files above pass under `pnpm test --filter @prosa/derived-v2`.
2. `prosa compile-all-v2 && prosa index-v2 status` shows Tantivy `status = ready` and `indexed_doc_count` matches `source_doc_count`.
3. `prosa session show <id>` against a v2 bundle renders a transcript identical to the v1 renderer for the same input.
4. `prosa analytics-v2 sessions` (CLI command added in Lane 7, but core function available here) returns the same row counts as `prosa analytics sessions` against v1.
5. Compaction trigger validated: scripted scenario imports 100 small epochs and verifies compaction reduces file count below threshold.

## Risks

| Risk | Mitigation |
|---|---|
| Tantivy schema fingerprint drift between v1 and v2 | Document migration: v1 fingerprint never expected to match v2; first v2 compile is always full rebuild. |
| Compaction breaks `bundleRoot` | The canonical leaf rule (Lane 0) is over row content, not file bytes. Test scenario asserts root unchanged after compaction. |
| Session blob page boundary surprises | The joint-constraint test includes adversarial cases: many small messages, one giant block, balanced workload. |
| Analytics view column drift from v1 contract | Snapshot fixture: per-view, captured columns + types from v1; v2 implementation must match byte-for-byte. |

## Unblocks

Lane 4 (`05-lane-4-server.md`) — server schema (Lane 4) does not depend on derived layer being ready, but the server's read API will rely on the same canonical types and similar view shapes. Starting Lane 4 in parallel is acceptable only after the canonical types (Lane 0) are frozen.
