import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Bundle } from '../core/bundle.js';
import { prepare, transactional } from '../core/db.js';
import { getErrorMessage } from '../core/errors.js';

export type SearchEngine = 'fts5' | 'tantivy';

export interface SearchIndexStatus {
  engine: SearchEngine;
  status: 'missing' | 'ready' | 'stale' | 'building' | 'failed';
  source_doc_count: number;
  indexed_doc_count: number;
  updated_at: string;
  error_message: string | null;
}

interface SearchDocRow {
  rowid: number;
  doc_id: string;
  entity_type: string;
  entity_id: string;
  session_id: string | null;
  project_id: string | null;
  timestamp: string | null;
  role: string | null;
  tool_name: string | null;
  canonical_tool_type: string | null;
  field_kind: string;
  text: string;
}

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
`;

export function enableFts5Triggers(bundle: Bundle): void {
  bundle.db.exec(FTS5_TRIGGER_SQL);
}

export function disableFts5Triggers(bundle: Bundle): void {
  bundle.db.exec(`
    DROP TRIGGER IF EXISTS search_docs_ai;
    DROP TRIGGER IF EXISTS search_docs_ad;
    DROP TRIGGER IF EXISTS search_docs_au;
  `);
}

export function getSearchIndexStatuses(bundle: Bundle): SearchIndexStatus[] {
  ensureSearchIndexStatusRows(bundle);
  return bundle.db
    .prepare<[], SearchIndexStatus>(
      `SELECT engine, status, source_doc_count, indexed_doc_count, updated_at, error_message
         FROM search_index_status
        ORDER BY engine`,
    )
    .all();
}

export function getSearchIndexStatus(
  bundle: Bundle,
  engine: SearchEngine,
): SearchIndexStatus | null {
  ensureSearchIndexStatusRows(bundle);
  return (
    bundle.db
      .prepare<[SearchEngine], SearchIndexStatus>(
        `SELECT engine, status, source_doc_count, indexed_doc_count, updated_at, error_message
           FROM search_index_status
          WHERE engine = ?`,
      )
      .get(engine) ?? null
  );
}

export function markIndexesAfterImport(
  bundle: Bundle,
  options: { changed: boolean; fts5Deferred: boolean },
): void {
  if (!options.changed) return;

  if (options.fts5Deferred) {
    updateSearchIndexStatus(bundle, 'fts5', {
      status: 'stale',
      sourceDocCount: countSearchDocs(bundle),
      indexedDocCount: countFts5Docs(bundle),
      errorMessage: null,
    });
  } else {
    updateSearchIndexStatus(bundle, 'fts5', {
      status: 'ready',
      sourceDocCount: countSearchDocs(bundle),
      indexedDocCount: countFts5Docs(bundle),
      errorMessage: null,
    });
  }

  const tantivy = getSearchIndexStatus(bundle, 'tantivy');
  if (tantivy?.status === 'ready' || tantivy?.status === 'stale' || tantivy?.status === 'failed') {
    updateSearchIndexStatus(bundle, 'tantivy', {
      status: 'stale',
      sourceDocCount: countSearchDocs(bundle),
      indexedDocCount: tantivy.indexed_doc_count,
      errorMessage: null,
    });
  }
}

export function rebuildFts5Index(bundle: Bundle): SearchIndexStatus {
  ensureSearchIndexStatusRows(bundle);
  updateSearchIndexStatus(bundle, 'fts5', {
    status: 'building',
    sourceDocCount: countSearchDocs(bundle),
    indexedDocCount: countFts5Docs(bundle),
    errorMessage: null,
  });

  try {
    transactional(bundle.db, () => {
      enableFts5Triggers(bundle);
      bundle.db.exec(`INSERT INTO search_docs_fts(search_docs_fts) VALUES('rebuild')`);
    });
    updateSearchIndexStatus(bundle, 'fts5', {
      status: 'ready',
      sourceDocCount: countSearchDocs(bundle),
      indexedDocCount: countFts5Docs(bundle),
      errorMessage: null,
    });
  } catch (error) {
    updateSearchIndexStatus(bundle, 'fts5', {
      status: 'failed',
      sourceDocCount: countSearchDocs(bundle),
      indexedDocCount: countFts5Docs(bundle),
      errorMessage: getErrorMessage(error),
    });
    throw error;
  }

  return getSearchIndexStatus(bundle, 'fts5') as SearchIndexStatus;
}

export async function rebuildTantivyIndex(bundle: Bundle): Promise<SearchIndexStatus> {
  ensureSearchIndexStatusRows(bundle);
  updateSearchIndexStatus(bundle, 'tantivy', {
    status: 'building',
    sourceDocCount: countSearchDocs(bundle),
    indexedDocCount: 0,
    errorMessage: null,
  });

  try {
    const tantivy = await import('@oxdev03/node-tantivy-binding');
    const schema = new tantivy.SchemaBuilder()
      .addTextField('doc_id', { stored: true, tokenizerName: 'raw' })
      .addTextField('entity_type', { stored: true, tokenizerName: 'raw' })
      .addTextField('entity_id', { stored: true, tokenizerName: 'raw' })
      .addTextField('session_id', { stored: true, tokenizerName: 'raw' })
      .addTextField('project_id', { stored: true, tokenizerName: 'raw' })
      .addTextField('timestamp', { stored: true, tokenizerName: 'raw' })
      .addTextField('role', { stored: true, tokenizerName: 'raw' })
      .addTextField('tool_name', { stored: true, tokenizerName: 'raw' })
      .addTextField('canonical_tool_type', { stored: true, tokenizerName: 'raw' })
      .addTextField('field_kind', { stored: true, tokenizerName: 'raw' })
      .addTextField('text', { stored: true })
      .build();

    await rm(bundle.paths.tantivy, { recursive: true, force: true });
    await mkdir(bundle.paths.tantivy, { recursive: true });

    const index = new tantivy.Index(schema, bundle.paths.tantivy, false);
    const writer = index.writer(50_000_000, 1);
    let indexedDocCount = 0;

    const rows = bundle.db
      .prepare<[], SearchDocRow>(
        `SELECT rowid, doc_id, entity_type, entity_id, session_id, project_id, timestamp,
                role, tool_name, canonical_tool_type, field_kind, text
           FROM search_docs
          ORDER BY rowid`,
      )
      .iterate();

    for (const row of rows) {
      const doc = new tantivy.Document();
      doc.addText('doc_id', row.doc_id);
      doc.addText('entity_type', row.entity_type);
      doc.addText('entity_id', row.entity_id);
      doc.addText('session_id', row.session_id ?? '');
      doc.addText('project_id', row.project_id ?? '');
      doc.addText('timestamp', row.timestamp ?? '');
      doc.addText('role', row.role ?? '');
      doc.addText('tool_name', row.tool_name ?? '');
      doc.addText('canonical_tool_type', row.canonical_tool_type ?? '');
      doc.addText('field_kind', row.field_kind);
      doc.addText('text', row.text);
      writer.addDocument(doc);
      indexedDocCount++;
    }

    writer.commit();
    index.reload();
    await writeFile(
      path.join(bundle.paths.tantivy, 'prosa-index.json'),
      `${JSON.stringify(
        {
          engine: 'tantivy',
          source: 'search_docs',
          built_at: new Date().toISOString(),
          source_doc_count: countSearchDocs(bundle),
          indexed_doc_count: indexedDocCount,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    updateSearchIndexStatus(bundle, 'tantivy', {
      status: 'ready',
      sourceDocCount: countSearchDocs(bundle),
      indexedDocCount,
      errorMessage: null,
    });
  } catch (error) {
    updateSearchIndexStatus(bundle, 'tantivy', {
      status: 'failed',
      sourceDocCount: countSearchDocs(bundle),
      indexedDocCount: 0,
      errorMessage: getErrorMessage(error),
    });
    throw error;
  }

  return getSearchIndexStatus(bundle, 'tantivy') as SearchIndexStatus;
}

function ensureSearchIndexStatusRows(bundle: Bundle): void {
  const now = new Date().toISOString();
  const stmt = prepare(
    bundle.db,
    `INSERT OR IGNORE INTO search_index_status (
       engine, status, source_doc_count, indexed_doc_count, updated_at, error_message
     ) VALUES (?, ?, 0, 0, ?, NULL)`,
  );
  stmt.run('fts5', 'ready', now);
  stmt.run('tantivy', 'missing', now);
}

function updateSearchIndexStatus(
  bundle: Bundle,
  engine: SearchEngine,
  values: {
    status: SearchIndexStatus['status'];
    sourceDocCount: number;
    indexedDocCount: number;
    errorMessage: string | null;
  },
): void {
  ensureSearchIndexStatusRows(bundle);
  prepare(
    bundle.db,
    `UPDATE search_index_status
        SET status = ?,
            source_doc_count = ?,
            indexed_doc_count = ?,
            updated_at = ?,
            error_message = ?
      WHERE engine = ?`,
  ).run(
    values.status,
    values.sourceDocCount,
    values.indexedDocCount,
    new Date().toISOString(),
    values.errorMessage,
    engine,
  );
}

function countSearchDocs(bundle: Bundle): number {
  return (
    bundle.db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM search_docs`).get()?.n ?? 0
  );
}

function countFts5Docs(bundle: Bundle): number {
  return (
    bundle.db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM search_docs_fts`).get()?.n ?? 0
  );
}
