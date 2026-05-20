// runTantivyRebuildForBundle end-to-end tests.
//
// Drive the full Lane 3 chain: synthetic NDJSON projection segment ->
// projection reader -> runtime writer -> native binding. Proves the
// gate condition (`indexed_doc_count == source_doc_count`) when the
// orchestrator is invoked the way the CLI / MCP runtime tool will.
//
// Heap/threads stay at the binding's 15 MB / 1-thread floor to keep
// the tests fast.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { searchDocSegmentPath } from '../../src/tantivy/projection-reader.js'
import { runTantivyRebuildForBundle } from '../../src/tantivy/rebuild-bundle.js'
import type { SearchDocInputV2 } from '../../src/tantivy/schema.js'
import { tantivyIndexStatus } from '../../src/tantivy/status.js'

const TEST_HEAP_BYTES = 15_000_000
const TEST_THREADS = 1

interface SearchDocFixture extends Omit<SearchDocInputV2, 'rowid'> {
  errors_only?: boolean
}

function fixture(i: number): SearchDocFixture {
  return {
    doc_id: `doc-${String(i).padStart(3, '0')}`,
    entity_type: 'message',
    entity_id: `msg-${i}`,
    session_id: 'ses_test',
    project_id: 'proj_test',
    timestamp: '2026-05-20T00:00:00Z',
    role: 'user',
    tool_name: null,
    canonical_tool_type: null,
    field_kind: 'message_text',
    text: `payload number ${i}`,
    errors_only: false,
  }
}

async function writeSegment(bundleRoot: string, epoch: number, rows: SearchDocFixture[]): Promise<string> {
  const path = searchDocSegmentPath(bundleRoot, epoch)
  await mkdir(dirname(path), { recursive: true })
  const header = JSON.stringify({
    bundleFormat: 2,
    segmentKind: 'projection_ndjson',
    entityType: 'search_doc',
    rowCount: rows.length,
  })
  const sorted = [...rows].sort((a, b) => (a.doc_id < b.doc_id ? -1 : a.doc_id > b.doc_id ? 1 : 0))
  const lines = [header, ...sorted.map((r) => JSON.stringify(r))]
  await writeFile(path, `${lines.join('\n')}\n`, 'utf-8')
  return path
}

describe('runTantivyRebuildForBundle', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-tantivy-bundle-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('reports `no_search_docs` when the projection segment is missing', async () => {
    const result = await runTantivyRebuildForBundle({ bundleRoot, epoch: 0 })
    expect(result.kind).toBe('no_search_docs')
    if (result.kind !== 'no_search_docs') throw new Error('unreachable')
    expect(result.segmentPath).toContain('epochs/0/projection/search_doc.prosa-projection.ndjson')
    const status = await tantivyIndexStatus(bundleRoot)
    expect(status.checkpoint_present).toBe(false)
    expect(status.ready_for_read).toBe(false)
  })

  it('drives a full rebuild end-to-end from a real projection segment and satisfies the Lane 3 gate', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => fixture(i + 1))
    await writeSegment(bundleRoot, 0, rows)
    const result = await runTantivyRebuildForBundle({
      bundleRoot,
      epoch: 0,
      heapBytes: TEST_HEAP_BYTES,
      numThreads: TEST_THREADS,
    })
    expect(result.kind).toBe('ran')
    if (result.kind !== 'ran') throw new Error('unreachable')
    expect(result.sourceDocCount).toBe(rows.length)
    expect(result.result.kind).toBe('rebuilt')
    if (result.result.kind !== 'rebuilt') throw new Error('unreachable')
    expect(result.result.plan.kind).toBe('full')
    expect(result.result.indexedDocCount).toBe(rows.length)
    expect(result.result.checkpoint.indexed_doc_count).toBe(result.result.checkpoint.source_doc_count)
    const status = await tantivyIndexStatus(bundleRoot)
    expect(status.ready_for_read).toBe(true)
    expect(status.index_dir_valid).toBe(true)
    expect(status.checkpoint?.indexed_doc_count).toBe(rows.length)
  })

  it('routes the second call against the same segment to `skip`', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => fixture(i + 1))
    await writeSegment(bundleRoot, 0, rows)
    await runTantivyRebuildForBundle({
      bundleRoot,
      epoch: 0,
      heapBytes: TEST_HEAP_BYTES,
      numThreads: TEST_THREADS,
    })
    const second = await runTantivyRebuildForBundle({
      bundleRoot,
      epoch: 0,
      heapBytes: TEST_HEAP_BYTES,
      numThreads: TEST_THREADS,
    })
    expect(second.kind).toBe('ran')
    if (second.kind !== 'ran') throw new Error('unreachable')
    expect(second.result.kind).toBe('skipped')
  })

  it('routes a wider segment to `incremental` and indexes only the new rows', async () => {
    const initial = Array.from({ length: 3 }, (_, i) => fixture(i + 1))
    await writeSegment(bundleRoot, 0, initial)
    const first = await runTantivyRebuildForBundle({
      bundleRoot,
      epoch: 0,
      heapBytes: TEST_HEAP_BYTES,
      numThreads: TEST_THREADS,
    })
    if (first.kind !== 'ran' || first.result.kind !== 'rebuilt') throw new Error('first run did not rebuild')
    const initialMax = first.result.newMaxRowid

    const expanded = Array.from({ length: 5 }, (_, i) => fixture(i + 1))
    await writeSegment(bundleRoot, 0, expanded)
    const second = await runTantivyRebuildForBundle({
      bundleRoot,
      epoch: 0,
      heapBytes: TEST_HEAP_BYTES,
      numThreads: TEST_THREADS,
    })
    expect(second.kind).toBe('ran')
    if (second.kind !== 'ran' || second.result.kind !== 'rebuilt') throw new Error('second run did not rebuild')
    expect(second.result.plan.kind).toBe('incremental')
    expect(second.result.addedDocCount).toBe(expanded.length - initialMax)
    expect(second.result.indexedDocCount).toBe(expanded.length)
    expect(second.result.checkpoint.indexed_doc_count).toBe(expanded.length)
    expect(second.result.checkpoint.source_doc_count).toBe(expanded.length)
  })

  it('CQ-115: forces full / epoch_mismatch when the bundle moves to a new epoch (and the index content matches the new segment, not the prior)', async () => {
    // Epoch 0 has three docs (synthetic rowids 1-3); doc_ids are
    // `doc-e0-*` so a later check against the index can distinguish
    // them from epoch 1's docs.
    const epoch0 = Array.from({ length: 3 }, (_, i) => ({ ...fixture(i + 1), doc_id: `doc-e0-${i + 1}` }))
    await writeSegment(bundleRoot, 0, epoch0)
    const first = await runTantivyRebuildForBundle({
      bundleRoot,
      epoch: 0,
      heapBytes: TEST_HEAP_BYTES,
      numThreads: TEST_THREADS,
    })
    if (first.kind !== 'ran' || first.result.kind !== 'rebuilt') throw new Error('epoch 0 did not rebuild')
    expect(first.result.checkpoint.last_indexed_epoch).toBe(0)
    expect(first.result.checkpoint.indexed_doc_count).toBe(3)
    expect(first.result.checkpoint.source_doc_count).toBe(3)

    // Epoch 1 has TWO docs (synthetic rowids 1-2). Without CQ-115
    // the planner would see `currentMaxRowid = 2 <= lastIndexedRowid
    // = 3` and `status === 'ready'` and route to `skip`, leaving
    // the checkpoint at 3/3 against the wrong epoch's rows.
    const epoch1 = Array.from({ length: 2 }, (_, i) => ({ ...fixture(i + 1), doc_id: `doc-e1-${i + 1}` }))
    await writeSegment(bundleRoot, 1, epoch1)
    const second = await runTantivyRebuildForBundle({
      bundleRoot,
      epoch: 1,
      heapBytes: TEST_HEAP_BYTES,
      numThreads: TEST_THREADS,
    })
    expect(second.kind).toBe('ran')
    if (second.kind !== 'ran' || second.result.kind !== 'rebuilt') {
      throw new Error('epoch 1 did not rebuild')
    }
    expect(second.result.plan.kind).toBe('full')
    expect(second.result.plan.reason).toBe('epoch_mismatch')
    expect(second.result.addedDocCount).toBe(2)
    expect(second.result.indexedDocCount).toBe(2)
    expect(second.result.checkpoint.last_indexed_epoch).toBe(1)
    expect(second.result.checkpoint.indexed_doc_count).toBe(2)
    expect(second.result.checkpoint.source_doc_count).toBe(2)

    // Index-content assertion: open the on-disk Tantivy index and
    // verify the searcher reports two docs total and that an
    // epoch-1-only doc_id matches while an epoch-0-only doc_id
    // does not. This rules out a regression that updates the
    // checkpoint correctly but leaves stale index segments.
    const tantivy = await import('@oxdev03/node-tantivy-binding')
    const index = tantivy.Index.open(join(bundleRoot, 'derived', 'tantivy', 'index'))
    const searcher = index.searcher()
    expect(searcher.numDocs).toBe(2)
    const e1Hit = searcher.search(index.parseQuery('"doc-e1-1"', ['doc_id']), 5).hits.length
    const e0Hit = searcher.search(index.parseQuery('"doc-e0-1"', ['doc_id']), 5).hits.length
    expect(e1Hit).toBeGreaterThan(0)
    expect(e0Hit).toBe(0)
  })

  it('CQ-115: re-running against the same epoch after the epoch_mismatch full still routes to skip', async () => {
    const epoch0 = Array.from({ length: 2 }, (_, i) => fixture(i + 1))
    await writeSegment(bundleRoot, 0, epoch0)
    await runTantivyRebuildForBundle({
      bundleRoot,
      epoch: 0,
      heapBytes: TEST_HEAP_BYTES,
      numThreads: TEST_THREADS,
    })
    const epoch1 = Array.from({ length: 4 }, (_, i) => ({ ...fixture(i + 1), doc_id: `doc-e1-${i + 1}` }))
    await writeSegment(bundleRoot, 1, epoch1)
    await runTantivyRebuildForBundle({
      bundleRoot,
      epoch: 1,
      heapBytes: TEST_HEAP_BYTES,
      numThreads: TEST_THREADS,
    })
    // Third call against epoch 1 with the same rows → planner sees
    // matching epoch + ready + currentMaxRowid <= lastIndexedRowid →
    // skip.
    const third = await runTantivyRebuildForBundle({
      bundleRoot,
      epoch: 1,
      heapBytes: TEST_HEAP_BYTES,
      numThreads: TEST_THREADS,
    })
    if (third.kind !== 'ran') throw new Error('third call did not run')
    expect(third.result.kind).toBe('skipped')
  })

  it('forces a full rebuild when overwriteRequested is true', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => fixture(i + 1))
    await writeSegment(bundleRoot, 0, rows)
    await runTantivyRebuildForBundle({
      bundleRoot,
      epoch: 0,
      heapBytes: TEST_HEAP_BYTES,
      numThreads: TEST_THREADS,
    })
    const forced = await runTantivyRebuildForBundle({
      bundleRoot,
      epoch: 0,
      overwriteRequested: true,
      heapBytes: TEST_HEAP_BYTES,
      numThreads: TEST_THREADS,
    })
    if (forced.kind !== 'ran' || forced.result.kind !== 'rebuilt') throw new Error('forced run did not rebuild')
    expect(forced.result.plan.kind).toBe('full')
    expect(forced.result.indexedDocCount).toBe(rows.length)
  })
})
