import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Bundle } from '../core/bundle.js'
import { prepare, transactional } from '../core/db.js'
import { getErrorMessage } from '../core/errors.js'

/** Supported search backends tracked by the bundle. */
export type SearchEngine = 'fts5' | 'tantivy'

/** Persisted status row for a search index sidecar. */
export interface SearchIndexStatus {
  /** Search backend represented by this status row. */
  engine: SearchEngine
  /** Current index lifecycle state. */
  status: 'missing' | 'ready' | 'stale' | 'building' | 'failed'
  /** Number of canonical search_docs rows available to index. */
  source_doc_count: number
  /** Number of documents known to be present in the index. */
  indexed_doc_count: number
  /** ISO timestamp for the last status update. */
  updated_at: string
  /** Last build error message, if the index failed. */
  error_message: string | null
  /** Last indexed SQLite rowid for incremental sidecars. */
  last_indexed_rowid: number | null
  /** Schema fingerprint used to decide whether incremental rebuild is valid. */
  schema_fingerprint: string | null
}

/** Canonical search document row used to feed external indexes. */
interface SearchDocRow {
  rowid: number
  doc_id: string
  entity_type: string
  entity_id: string
  session_id: string | null
  project_id: string | null
  timestamp: string | null
  role: string | null
  tool_name: string | null
  canonical_tool_type: string | null
  field_kind: string
  text: string
}

/** Shared projection for search index status queries. */
const SEARCH_INDEX_STATUS_COLUMNS = `
  engine, status, source_doc_count, indexed_doc_count, updated_at,
  error_message, last_indexed_rowid, schema_fingerprint
`

/** Triggers that keep the SQLite FTS5 virtual table synchronized with search_docs. */
const FTS5_TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS search_docs_ai AFTER INSERT ON search_docs BEGIN
  INSERT INTO search_docs_fts(rowid, text, role, tool_name, field_kind)
  VALUES (new.rowid, new.text, new.role, new.tool_name, new.field_kind);
END;

CREATE TRIGGER IF NOT EXISTS search_docs_ad AFTER DELETE ON search_docs BEGIN
  INSERT INTO search_docs_fts(search_docs_fts, rowid, text, role, tool_name, field_kind)
  VALUES('delete', old.rowid, old.text, old.role, old.tool_name, old.field_kind);
END;

CREATE TRIGGER IF NOT EXISTS search_docs_au AFTER UPDATE ON search_docs BEGIN
  INSERT INTO search_docs_fts(search_docs_fts, rowid, text, role, tool_name, field_kind)
  VALUES('delete', old.rowid, old.text, old.role, old.tool_name, old.field_kind);
  INSERT INTO search_docs_fts(rowid, text, role, tool_name, field_kind)
  VALUES (new.rowid, new.text, new.role, new.tool_name, new.field_kind);
END;
`

/** Enables incremental FTS5 maintenance after bulk rebuilds or imports. */
export function enableFts5Triggers(bundle: Bundle): void {
  bundle.db.exec(FTS5_TRIGGER_SQL)
}

/** Disables FTS5 maintenance triggers while import code performs bulk writes. */
export function disableFts5Triggers(bundle: Bundle): void {
  bundle.db.exec(`
    DROP TRIGGER IF EXISTS search_docs_ai;
    DROP TRIGGER IF EXISTS search_docs_ad;
    DROP TRIGGER IF EXISTS search_docs_au;
  `)
}

/** Returns status rows for all known search engines, creating defaults if absent. */
export function getSearchIndexStatuses(bundle: Bundle): SearchIndexStatus[] {
  ensureSearchIndexStatusRows(bundle)
  return bundle.db
    .prepare<[], SearchIndexStatus>(
      `SELECT ${SEARCH_INDEX_STATUS_COLUMNS}
         FROM search_index_status
        ORDER BY engine`,
    )
    .all()
}

/** Returns the status row for one search engine, or null only if initialization failed. */
export function getSearchIndexStatus(bundle: Bundle, engine: SearchEngine): SearchIndexStatus | null {
  ensureSearchIndexStatusRows(bundle)
  return (
    bundle.db
      .prepare<[SearchEngine], SearchIndexStatus>(
        `SELECT ${SEARCH_INDEX_STATUS_COLUMNS}
           FROM search_index_status
          WHERE engine = ?`,
      )
      .get(engine) ?? null
  )
}

/** Marks derived search indexes stale after canonical search_docs changed. */
export function markIndexesAfterImport(bundle: Bundle, options: { changed: boolean }): void {
  if (!options.changed) return

  const tantivy = getSearchIndexStatus(bundle, 'tantivy')
  if (tantivy?.status === 'ready' || tantivy?.status === 'stale' || tantivy?.status === 'failed') {
    updateSearchIndexStatus(bundle, 'tantivy', {
      status: 'stale',
      sourceDocCount: countSearchDocs(bundle),
      indexedDocCount: tantivy.indexed_doc_count,
      errorMessage: null,
    })
  }
}

/** Fully rebuilds the SQLite FTS5 index from search_docs and records status. */
export function rebuildFts5Index(bundle: Bundle): SearchIndexStatus {
  ensureSearchIndexStatusRows(bundle)
  updateSearchIndexStatus(bundle, 'fts5', {
    status: 'building',
    sourceDocCount: countSearchDocs(bundle),
    indexedDocCount: countFts5Docs(bundle),
    errorMessage: null,
  })

  try {
    transactional(bundle.db, () => {
      enableFts5Triggers(bundle)
      bundle.db.exec(`INSERT INTO search_docs_fts(search_docs_fts) VALUES('rebuild')`)
    })
    updateSearchIndexStatus(bundle, 'fts5', {
      status: 'ready',
      sourceDocCount: countSearchDocs(bundle),
      indexedDocCount: countFts5Docs(bundle),
      errorMessage: null,
    })
  } catch (error) {
    updateSearchIndexStatus(bundle, 'fts5', {
      status: 'failed',
      sourceDocCount: countSearchDocs(bundle),
      indexedDocCount: countFts5Docs(bundle),
      errorMessage: getErrorMessage(error),
    })
    throw error
  }

  return getSearchIndexStatus(bundle, 'fts5') as SearchIndexStatus
}

/** Options controlling Tantivy sidecar rebuild behavior. */
export interface RebuildTantivyOptions {
  /**
   * Force a full re-index even when an incremental run would be valid.
   * Surfaced by the `--overwrite` flag on `prosa index tantivy` and on
   * `prosa compile`.
   */
  overwrite?: boolean
}

type TantivyModule = typeof import('@oxdev03/node-tantivy-binding')

/** Stored Tantivy schema field used for schema fingerprinting and indexing. */
interface TantivySchemaField {
  name: string
  tokenizer: string
}

/**
 * Ordered list of fields stored on every Tantivy document.
 *
 * The order is load-bearing: the schema fingerprint hashes this list verbatim,
 * so changing the order forces a full rebuild on existing bundles.
 */
const TANTIVY_SCHEMA_FIELDS: readonly TantivySchemaField[] = [
  { name: 'doc_id', tokenizer: 'raw' },
  { name: 'entity_type', tokenizer: 'raw' },
  { name: 'entity_id', tokenizer: 'raw' },
  { name: 'session_id', tokenizer: 'raw' },
  { name: 'project_id', tokenizer: 'raw' },
  { name: 'timestamp', tokenizer: 'raw' },
  { name: 'role', tokenizer: 'raw' },
  { name: 'tool_name', tokenizer: 'raw' },
  { name: 'canonical_tool_type', tokenizer: 'raw' },
  { name: 'field_kind', tokenizer: 'raw' },
  // The text field uses Tantivy's default tokenizer (en_stem in the binding).
  { name: 'text', tokenizer: 'default' },
]

/** Builds the Tantivy schema from the fingerprinted field policy. */
function buildTantivySchema(tantivy: TantivyModule): InstanceType<TantivyModule['Schema']> {
  const builder = new tantivy.SchemaBuilder()
  for (const field of TANTIVY_SCHEMA_FIELDS) {
    if (field.tokenizer === 'default') {
      builder.addTextField(field.name, { stored: true })
    } else {
      builder.addTextField(field.name, { stored: true, tokenizerName: field.tokenizer })
    }
  }
  return builder.build()
}

/** Returns the fingerprint that decides whether Tantivy can rebuild incrementally. */
export function getCurrentTantivySchemaFingerprint(): string {
  const canonical = TANTIVY_SCHEMA_FIELDS.map((f) => `${f.name}:${f.tokenizer}:stored`).join('|')
  return createHash('sha256').update(canonical).digest('hex')
}

/** Checks for Tantivy's metadata file without opening the optional binding. */
export function tantivyIndexDirIsValid(dir: string): boolean {
  return existsSync(path.join(dir, 'meta.json'))
}

/** Maps a canonical search_docs row into one stored Tantivy document. */
function makeTantivyDoc(tantivy: TantivyModule, row: SearchDocRow): InstanceType<TantivyModule['Document']> {
  const doc = new tantivy.Document()
  doc.addText('doc_id', row.doc_id)
  doc.addText('entity_type', row.entity_type)
  doc.addText('entity_id', row.entity_id)
  doc.addText('session_id', row.session_id ?? '')
  doc.addText('project_id', row.project_id ?? '')
  doc.addText('timestamp', row.timestamp ?? '')
  doc.addText('role', row.role ?? '')
  doc.addText('tool_name', row.tool_name ?? '')
  doc.addText('canonical_tool_type', row.canonical_tool_type ?? '')
  doc.addText('field_kind', row.field_kind)
  doc.addText('text', row.text)
  return doc
}

/** Base projection used by full and incremental Tantivy indexing. */
const SEARCH_DOCS_SELECT = `
  SELECT rowid, doc_id, entity_type, entity_id, session_id, project_id, timestamp,
         role, tool_name, canonical_tool_type, field_kind, text
    FROM search_docs
`

/** Rebuilds the Tantivy sidecar, using an incremental append path when valid. */
export async function rebuildTantivyIndex(
  bundle: Bundle,
  options: RebuildTantivyOptions = {},
): Promise<SearchIndexStatus> {
  ensureSearchIndexStatusRows(bundle)
  const sourceDocCount = countSearchDocs(bundle)

  // Read the *previous* status before we mark it 'building' — we rely on it
  // to decide between full and incremental, and on the prior indexed count
  // to project the post-incremental total.
  const prev = getSearchIndexStatus(bundle, 'tantivy')
  const fingerprint = getCurrentTantivySchemaFingerprint()
  const indexDirValid = tantivyIndexDirIsValid(bundle.paths.tantivy)
  const fingerprintMatches = prev?.schema_fingerprint === fingerprint
  const lastIndexedRowid = typeof prev?.last_indexed_rowid === 'number' ? prev.last_indexed_rowid : 0
  const wantFullRebuild = options.overwrite === true || !indexDirValid || !fingerprintMatches || lastIndexedRowid <= 0

  updateSearchIndexStatus(bundle, 'tantivy', {
    status: 'building',
    sourceDocCount,
    indexedDocCount: 0,
    errorMessage: null,
  })

  try {
    const tantivy = await import('@oxdev03/node-tantivy-binding')
    const schema = buildTantivySchema(tantivy)

    let index: InstanceType<TantivyModule['Index']>
    if (wantFullRebuild) {
      await rm(bundle.paths.tantivy, { recursive: true, force: true })
      await mkdir(bundle.paths.tantivy, { recursive: true })
      index = new tantivy.Index(schema, bundle.paths.tantivy, false)
    } else {
      index = tantivy.Index.open(bundle.paths.tantivy)
    }

    const writer = index.writer(300_000_000, 4)
    const select = wantFullRebuild
      ? `${SEARCH_DOCS_SELECT} ORDER BY rowid`
      : `${SEARCH_DOCS_SELECT} WHERE rowid > ${lastIndexedRowid} ORDER BY rowid`

    let addedDocCount = 0
    let maxRowid = wantFullRebuild ? 0 : lastIndexedRowid
    for (const row of bundle.db.prepare<[], SearchDocRow>(select).iterate()) {
      if (!wantFullRebuild) {
        // Defensive: lets re-imported docs replace the prior copy. The
        // tokenizer for `doc_id` is `raw`, so the stored value maps 1:1
        // to a single deletable term.
        writer.deleteDocumentsByTerm('doc_id', row.doc_id)
      }
      writer.addDocument(makeTantivyDoc(tantivy, row))
      addedDocCount++
      if (row.rowid > maxRowid) maxRowid = row.rowid
    }

    writer.commit()
    index.reload()
    // Drop the writer deterministically so the directory lock is released
    // before the next rebuildTantivyIndex call (e.g. consecutive runs in
    // the same process).
    writer.waitMergingThreads()

    const indexedDocCount = wantFullRebuild ? addedDocCount : countTantivyDocsBest(prev, addedDocCount)

    await writeFile(
      path.join(bundle.paths.tantivy, 'prosa-index.json'),
      `${JSON.stringify(
        {
          engine: 'tantivy',
          source: 'search_docs',
          built_at: new Date().toISOString(),
          mode: wantFullRebuild ? 'full' : 'incremental',
          source_doc_count: sourceDocCount,
          indexed_doc_count: indexedDocCount,
          last_indexed_rowid: maxRowid,
          schema_fingerprint: fingerprint,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    updateSearchIndexStatus(bundle, 'tantivy', {
      status: 'ready',
      sourceDocCount,
      indexedDocCount,
      errorMessage: null,
      lastIndexedRowid: maxRowid,
      schemaFingerprint: fingerprint,
    })
  } catch (error) {
    updateSearchIndexStatus(bundle, 'tantivy', {
      status: 'failed',
      sourceDocCount,
      indexedDocCount: 0,
      errorMessage: getErrorMessage(error),
    })
    throw error
  }

  return getSearchIndexStatus(bundle, 'tantivy') as SearchIndexStatus
}

/**
 * Estimates Tantivy's post-incremental document count from prior recorded
 * state because the binding does not expose a cheap committed count here.
 */
function countTantivyDocsBest(prev: SearchIndexStatus | null, added: number): number {
  if (prev && typeof prev.indexed_doc_count === 'number') {
    return prev.indexed_doc_count + added
  }
  return added
}

/** Ensures every supported search engine has a status row before reads/writes. */
function ensureSearchIndexStatusRows(bundle: Bundle): void {
  const now = new Date().toISOString()
  const stmt = prepare(
    bundle.db,
    `INSERT OR IGNORE INTO search_index_status (
       engine, status, source_doc_count, indexed_doc_count, updated_at,
       error_message, last_indexed_rowid, schema_fingerprint
     ) VALUES (?, ?, 0, 0, ?, NULL, NULL, NULL)`,
  )
  stmt.run('fts5', 'ready', now)
  stmt.run('tantivy', 'missing', now)
}

/** Partial search_index_status update; optional fields leave columns unchanged. */
interface UpdateSearchIndexValues {
  status: SearchIndexStatus['status']
  sourceDocCount: number
  indexedDocCount: number
  errorMessage: string | null
  /** undefined leaves the column untouched; null clears it. */
  lastIndexedRowid?: number | null
  /** undefined leaves the column untouched; null clears it. */
  schemaFingerprint?: string | null
}

/** Writes status metadata while preserving optional columns unless explicitly provided. */
function updateSearchIndexStatus(bundle: Bundle, engine: SearchEngine, values: UpdateSearchIndexValues): void {
  ensureSearchIndexStatusRows(bundle)
  const setClauses = [
    'status = ?',
    'source_doc_count = ?',
    'indexed_doc_count = ?',
    'updated_at = ?',
    'error_message = ?',
  ]
  const params: unknown[] = [
    values.status,
    values.sourceDocCount,
    values.indexedDocCount,
    new Date().toISOString(),
    values.errorMessage,
  ]
  if (values.lastIndexedRowid !== undefined) {
    setClauses.push('last_indexed_rowid = ?')
    params.push(values.lastIndexedRowid)
  }
  if (values.schemaFingerprint !== undefined) {
    setClauses.push('schema_fingerprint = ?')
    params.push(values.schemaFingerprint)
  }
  params.push(engine)
  prepare(bundle.db, `UPDATE search_index_status SET ${setClauses.join(', ')} WHERE engine = ?`).run(...params)
}

/** Counts canonical search_docs rows that derived indexes should cover. */
export function countSearchDocs(bundle: Bundle): number {
  return bundle.db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM search_docs`).get()?.n ?? 0
}

/** Counts rows currently present in the SQLite FTS5 virtual table. */
export function countFts5Docs(bundle: Bundle): number {
  return bundle.db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM search_docs_fts`).get()?.n ?? 0
}
