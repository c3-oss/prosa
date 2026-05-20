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
