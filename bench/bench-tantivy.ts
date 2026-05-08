// Benchmark: Tantivy rebuild full vs incremental, threading variations.
// Run via: pnpm dev:exec /tmp/bench-tantivy.ts (or node --import @swc-node/register)
//
// Usage: spawn from project root.

import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as tantivy from '@oxdev03/node-tantivy-binding';

const DB_PATH = '/tmp/prosa-bench.sqlite';
const BENCH_DIR = '/tmp/prosa-bench';

interface Row {
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

function buildSchema(): tantivy.Schema {
  return new tantivy.SchemaBuilder()
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
}

function* iterateRows(db: Database.Database, where = '') {
  const stmt = db.prepare<unknown[], Row>(
    `SELECT rowid, doc_id, entity_type, entity_id, session_id, project_id, timestamp,
            role, tool_name, canonical_tool_type, field_kind, text
       FROM search_docs
       ${where}
      ORDER BY rowid`,
  );
  for (const row of stmt.iterate()) yield row;
}

function makeDoc(row: Row): tantivy.Document {
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
  return doc;
}

async function rebuildFull(
  db: Database.Database,
  outDir: string,
  heapBytes: number,
  threads: number,
): Promise<{ ms: number; docs: number }> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const schema = buildSchema();
  const index = new tantivy.Index(schema, outDir, false);
  const writer = index.writer(heapBytes, threads);
  let docs = 0;
  const t0 = performance.now();
  for (const row of iterateRows(db)) {
    writer.addDocument(makeDoc(row));
    docs++;
  }
  writer.commit();
  index.reload();
  const ms = performance.now() - t0;
  return { ms, docs };
}

async function incrementalAdd(
  db: Database.Database,
  outDir: string,
  startRowid: number,
  heapBytes: number,
  threads: number,
): Promise<{ ms: number; docs: number }> {
  // Assumes outDir already has an existing index from a prior full build.
  const index = tantivy.Index.open(outDir);
  const writer = index.writer(heapBytes, threads);
  let docs = 0;
  const t0 = performance.now();
  for (const row of iterateRows(db, `WHERE rowid >= ${startRowid}`)) {
    writer.deleteDocumentsByTerm('doc_id', row.doc_id);
    writer.addDocument(makeDoc(row));
    docs++;
  }
  writer.commit();
  index.reload();
  const ms = performance.now() - t0;
  return { ms, docs };
}

async function main() {
  await rm(BENCH_DIR, { recursive: true, force: true });
  await mkdir(BENCH_DIR, { recursive: true });
  const db = new Database(DB_PATH, { readonly: true });
  const totalDocs = (db.prepare('SELECT count(*) AS n FROM search_docs').get() as { n: number }).n;
  console.log(`baseline: ${totalDocs} search_docs`);

  // Choose a starting rowid that gives ~5% of docs (proxy for a steady-state import)
  const cutoff = (db
    .prepare('SELECT rowid FROM search_docs ORDER BY rowid LIMIT 1 OFFSET ?')
    .get(Math.floor(totalDocs * 0.95)) as { rowid: number }).rowid;
  console.log(`incremental cutoff: rowid >= ${cutoff} (~5% of docs)\n`);

  const cases: Array<{ label: string; heap: number; threads: number }> = [
    { label: 'baseline-current  (50MB, 1 thread)', heap: 50_000_000, threads: 1 },
    { label: '4 threads        (300MB, 4 threads)', heap: 300_000_000, threads: 4 },
    { label: '8 threads        (600MB, 8 threads)', heap: 600_000_000, threads: 8 },
    { label: 'memory-only      (200MB, 1 thread)', heap: 200_000_000, threads: 1 },
  ];

  console.log('=== FULL REBUILDS ===');
  for (const c of cases) {
    const dir = path.join(BENCH_DIR, `full-${c.label.replace(/\s+/g, '_')}`);
    const r = await rebuildFull(db, dir, c.heap, c.threads);
    console.log(`${c.label}: ${(r.ms / 1000).toFixed(2)}s for ${r.docs} docs (${(r.docs / (r.ms / 1000)).toFixed(0)} docs/s)`);
  }

  console.log('\n=== INCREMENTAL (~5% of docs added on top of existing index) ===');
  // Build a baseline index once, then run incremental cases on copies of it.
  const baseDir = path.join(BENCH_DIR, 'inc-base');
  await rebuildFull(db, baseDir, 300_000_000, 4);
  for (const c of cases) {
    const workDir = path.join(BENCH_DIR, `inc-${c.label.replace(/\s+/g, '_')}`);
    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true });
    // Copy the base index
    const { spawnSync } = await import('node:child_process');
    spawnSync('cp', ['-R', `${baseDir}/.`, workDir]);
    const r = await incrementalAdd(db, workDir, cutoff, c.heap, c.threads);
    console.log(`${c.label}: ${(r.ms / 1000).toFixed(2)}s for ${r.docs} docs (${(r.docs / (r.ms / 1000)).toFixed(0)} docs/s)`);
  }

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
