// `search_doc` projection-segment reader.
//
// Bundle v2 stores each entity's canonical projection as one NDJSON
// segment per epoch:
//   `<bundleRoot>/epochs/<epoch>/projection/search_doc.prosa-projection.ndjson`
//
// The file starts with one canonical-JSON header line (the segment
// metadata: `bundleFormat`, `segmentKind`, `entityType`, `rowCount`)
// followed by one canonical-JSON `SearchDocV2` row per line. Rows are
// pre-sorted by `doc_id` ASCII bytewise (CANONICAL.md rule 7) so the
// reader does not re-sort.
//
// This module is the row producer that the Tantivy runtime writer
// consumes for `runTantivyRebuildForBundle`. It is intentionally
// minimal:
//
//   - Parses NDJSON lazily line-by-line (`createReadStream` +
//     `readline`) so a large segment does not need to materialise in
//     memory.
//   - Assigns a synthetic `rowid` per row (1-based, monotonic). The
//     v2 projection has no native rowid column — each epoch is a
//     full snapshot — so we treat the sorted segment position as the
//     stable identity for the planner's `last_indexed_rowid`
//     watermark. Inside a single epoch this is stable; across
//     epochs the snapshot resets, and the bundle-level orchestrator
//     forces a `full` rebuild when the epoch changes.
//   - Maps `SearchDocV2` (canonical projection shape) into
//     `SearchDocInputV2` (Tantivy input shape). The two shapes are
//     near-identical; the projection's `errors_only` boolean is not
//     stored in the index, so the reader drops it.
//
// Errors:
//
//   - Missing projection segment → `null` (caller decides whether to
//     route to "no docs / nothing to index" or to throw).
//   - Malformed JSON / missing primary key → throws so the runtime
//     can surface a corrupt projection rather than indexing partial
//     data.
//   - Symlinked epoch / segment path → currently NOT validated
//     here; the bundle-v2 layer already enforces real paths during
//     `sealEpoch`. The Tantivy index directory has its own
//     CQ-094/CQ-096 containment via `index-dir.ts`.

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import type { SearchDocInputV2 } from './schema.js'

/** Canonical on-disk path of the `search_doc` projection segment for
 *  a given epoch. Pure path resolution — does not touch the
 *  filesystem. */
export function searchDocSegmentPath(bundleRoot: string, epoch: number): string {
  return join(bundleRoot, 'epochs', String(epoch), 'projection', 'search_doc.prosa-projection.ndjson')
}

/** Outcome of reading the projection segment. */
export interface SearchDocSegmentRead {
  /** Path the reader resolved (for error messages and tracing). */
  segmentPath: string
  /** Materialised `SearchDocInputV2` rows in segment order
   *  (sorted by `doc_id` ASCII bytewise per CANONICAL.md rule 7).
   *  Each row carries a synthetic `rowid` = `position + 1`. */
  rows: SearchDocInputV2[]
  /** Highest rowid present in `rows` (0 when empty). */
  maxRowid: number
  /** Total row count — `rows.length`. Plumbed separately so callers
   *  reading a streaming variant can report the count without
   *  materialising the rows. */
  sourceDocCount: number
}

/**
 * Locate and read the `search_doc` projection segment for an epoch.
 * Returns `null` when the segment file does not exist (the epoch has
 * no search_docs — e.g. an empty bundle or a CAS-only epoch).
 *
 * Throws when the file exists but is empty (missing header), the
 * header line is not parseable JSON, a body line is not parseable
 * JSON, or any body row is missing the required `doc_id` field.
 */
export async function readSearchDocSegment(bundleRoot: string, epoch: number): Promise<SearchDocSegmentRead | null> {
  const segmentPath = searchDocSegmentPath(bundleRoot, epoch)
  try {
    const st = await stat(segmentPath)
    if (!st.isFile()) {
      throw new Error(`readSearchDocSegment: ${segmentPath} exists but is not a regular file`)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw err
  }

  const rl = createInterface({
    input: createReadStream(segmentPath, { encoding: 'utf-8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  })

  let lineNumber = 0
  let headerSeen = false
  const rows: SearchDocInputV2[] = []
  let nextRowid = 1
  try {
    for await (const raw of rl) {
      lineNumber += 1
      if (raw.length === 0) continue
      if (!headerSeen) {
        // First non-empty line is the header. We do not enforce the
        // header shape beyond confirming it parses; the rebuild
        // path (`packages/prosa-bundle-v2/.../rebuild/index.ts`)
        // already verifies the segment digest against the manifest,
        // so any tampering surfaces there.
        try {
          JSON.parse(raw)
        } catch (parseErr) {
          throw new Error(
            `readSearchDocSegment: ${segmentPath} line ${lineNumber} (header) is not valid JSON: ${(parseErr as Error).message}`,
          )
        }
        headerSeen = true
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (parseErr) {
        throw new Error(
          `readSearchDocSegment: ${segmentPath} line ${lineNumber} is not valid JSON: ${(parseErr as Error).message}`,
        )
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`readSearchDocSegment: ${segmentPath} line ${lineNumber} is not a JSON object`)
      }
      const row = parsed as Record<string, unknown>
      const docId = row.doc_id
      if (typeof docId !== 'string' || docId.length === 0) {
        throw new Error(`readSearchDocSegment: ${segmentPath} line ${lineNumber} missing required doc_id`)
      }
      rows.push({
        rowid: nextRowid,
        doc_id: docId,
        entity_type: stringOrEmpty(row.entity_type),
        entity_id: stringOrEmpty(row.entity_id),
        session_id: nullableString(row.session_id),
        project_id: nullableString(row.project_id),
        timestamp: nullableString(row.timestamp),
        role: nullableString(row.role),
        tool_name: nullableString(row.tool_name),
        canonical_tool_type: nullableString(row.canonical_tool_type),
        field_kind: stringOrEmpty(row.field_kind),
        text: stringOrEmpty(row.text),
      })
      nextRowid += 1
    }
  } finally {
    rl.close()
  }
  if (!headerSeen) {
    throw new Error(`readSearchDocSegment: ${segmentPath} is empty (missing header)`)
  }
  const maxRowid = rows.length === 0 ? 0 : (rows[rows.length - 1]?.rowid ?? 0)
  return { segmentPath, rows, maxRowid, sourceDocCount: rows.length }
}

function stringOrEmpty(v: unknown): string {
  if (typeof v === 'string') return v
  return ''
}

function nullableString(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v
  return null
}
