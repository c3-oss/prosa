// runTantivyRebuild runtime executor tests.
//
// These are integration tests against the real
// `@oxdev03/node-tantivy-binding` binding. They cover the three
// runtime branches the planner can hand to the writer (full,
// incremental, skip), prove the Lane 3 gate condition
// (`indexed_doc_count == source_doc_count`) after a full rebuild,
// and confirm the index dir contains a real Tantivy `meta.json` so
// the read-side probe (`tantivyIndexDirIsValid`) flips to true.
//
// Heap/thread tuning is intentionally minimal: 1 thread × 15 MB heap
// (the binding's per-thread floor) keeps the test fast.

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readIndexCheckpoint } from '../../src/tantivy/checkpoint-store.js'
import { tantivyIndexDirIsValid, tantivyMetaPath } from '../../src/tantivy/index-dir.js'
import type { RebuildPlan } from '../../src/tantivy/rebuild-plan.js'
import { runTantivyRebuild } from '../../src/tantivy/runtime-writer.js'
import type { SearchDocInputV2 } from '../../src/tantivy/schema.js'
import { currentTantivySchemaFingerprint } from '../../src/tantivy/schema.js'
import { tantivyIndexStatus } from '../../src/tantivy/status.js'

const TEST_HEAP_BYTES = 15_000_000
const TEST_THREADS = 1

function makeRow(rowid: number, suffix: string): SearchDocInputV2 {
  return {
    rowid,
    doc_id: `doc-${rowid}`,
    entity_type: 'message',
    entity_id: `msg-${rowid}`,
    session_id: 'ses_test',
    project_id: 'proj_test',
    timestamp: '2026-05-20T00:00:00Z',
    role: 'user',
    tool_name: null,
    canonical_tool_type: null,
    field_kind: 'text',
    text: `hello world payload ${suffix}`,
  }
}

function rowsFor(rows: SearchDocInputV2[]) {
  return (plan: RebuildPlan): Iterable<SearchDocInputV2> => {
    if (plan.kind === 'incremental') {
      return rows.filter((r) => r.rowid > plan.lastIndexedRowid)
    }
    if (plan.kind === 'full') {
      return rows
    }
    // skip plan should not invoke loadRows; return empty just in case.
    return []
  }
}

describe('runTantivyRebuild', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-tantivy-runtime-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('runs a full rebuild end-to-end and reports indexed_doc_count === source_doc_count', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => makeRow(i + 1, `payload-${i}`))
    const result = await runTantivyRebuild({
      bundleRoot,
      currentMaxRowid: 12,
      sourceDocCount: rows.length,
      loadRows: rowsFor(rows),
      heapBytes: TEST_HEAP_BYTES,
      numThreads: TEST_THREADS,
    })
    expect(result.kind).toBe('rebuilt')
    if (result.kind !== 'rebuilt') throw new Error('unreachable')
    expect(result.plan.kind).toBe('full')
    expect(result.addedDocCount).toBe(rows.length)
    expect(result.indexedDocCount).toBe(rows.length)
    expect(result.newMaxRowid).toBe(12)
    expect(result.checkpoint.status).toBe('ready')
    expect(result.checkpoint.indexed_doc_count).toBe(result.checkpoint.source_doc_count)
    expect(result.checkpoint.schema_fingerprint).toBe(currentTantivySchemaFingerprint())
    // Lane 3 gate: the on-disk probe flips to true after the writer
    // commits, and the read-side status snapshot reports `ready_for_read`.
    expect(await tantivyIndexDirIsValid(bundleRoot)).toBe(true)
    const meta = JSON.parse(await readFile(tantivyMetaPath(bundleRoot), 'utf-8')) as {
      segments: unknown[]
    }
    expect(Array.isArray(meta.segments)).toBe(true)
    expect(meta.segments.length).toBeGreaterThan(0)
    const status = await tantivyIndexStatus(bundleRoot)
    expect(status.ready_for_read).toBe(true)
    expect(status.checkpoint?.indexed_doc_count).toBe(rows.length)
  })

  it('skips when the plan says the index is already up-to-date', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => makeRow(i + 1, `p${i}`))
    await runTantivyRebuild({
      bundleRoot,
      currentMaxRowid: 4,
      sourceDocCount: rows.length,
      loadRows: rowsFor(rows),
      heapBytes: TEST_HEAP_BYTES,
      numThreads: TEST_THREADS,
    })
    // Capture checkpoint mtime so we can prove the skip path does not
    // rewrite the file unnecessarily.
    const before = await stat(join(bundleRoot, 'derived', 'tantivy', 'checkpoint.json'))
    let loadRowsCalled = false
    const skipResult = await runTantivyRebuild({
      bundleRoot,
      currentMaxRowid: 4,
      sourceDocCount: rows.length,
      loadRows: (plan) => {
        loadRowsCalled = true
        return rowsFor(rows)(plan)
      },
      heapBytes: TEST_HEAP_BYTES,
      numThreads: TEST_THREADS,
    })
    expect(skipResult.kind).toBe('skipped')
    if (skipResult.kind !== 'skipped') throw new Error('unreachable')
    expect(skipResult.plan.kind).toBe('skip')
    // The skip path never opens the native writer or touches the
    // row producer; checkpoint file is left untouched.
    expect(loadRowsCalled).toBe(false)
    const after = await stat(join(bundleRoot, 'derived', 'tantivy', 'checkpoint.json'))
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it('appends only the new rows on an incremental rebuild', async () => {
    const initial = Array.from({ length: 3 }, (_, i) => makeRow(i + 1, `init-${i}`))
    await runTantivyRebuild({
      bundleRoot,
      currentMaxRowid: 3,
      sourceDocCount: initial.length,
      loadRows: rowsFor(initial),
      heapBytes: TEST_HEAP_BYTES,
      numThreads: TEST_THREADS,
    })

    const all = [...initial, makeRow(4, 'new-4'), makeRow(5, 'new-5')]
    const result = await runTantivyRebuild({
      bundleRoot,
      currentMaxRowid: 5,
      sourceDocCount: all.length,
      loadRows: rowsFor(all),
      heapBytes: TEST_HEAP_BYTES,
      numThreads: TEST_THREADS,
    })
    expect(result.kind).toBe('rebuilt')
    if (result.kind !== 'rebuilt') throw new Error('unreachable')
    expect(result.plan.kind).toBe('incremental')
    expect(result.addedDocCount).toBe(2)
    expect(result.indexedDocCount).toBe(all.length)
    expect(result.newMaxRowid).toBe(5)
    expect(result.checkpoint.indexed_doc_count).toBe(all.length)
    expect(result.checkpoint.source_doc_count).toBe(all.length)
    expect(result.checkpoint.last_indexed_rowid).toBe(5)
  })

  it('persists a failed checkpoint when the row producer throws', async () => {
    const boom = new Error('synthetic projection failure')
    await expect(
      runTantivyRebuild({
        bundleRoot,
        currentMaxRowid: 5,
        sourceDocCount: 5,
        loadRows: () => {
          throw boom
        },
        heapBytes: TEST_HEAP_BYTES,
        numThreads: TEST_THREADS,
      }),
    ).rejects.toThrow('synthetic projection failure')
    const cp = await readIndexCheckpoint(bundleRoot)
    expect(cp).not.toBeNull()
    expect(cp?.status).toBe('failed')
    expect(cp?.error_message).toContain('synthetic projection failure')
  })

  it('rejects writer tuning below the Tantivy 3 MB-per-thread floor', async () => {
    await expect(
      runTantivyRebuild({
        bundleRoot,
        currentMaxRowid: 0,
        sourceDocCount: 0,
        loadRows: () => [],
        heapBytes: 1_000_000,
        numThreads: 1,
      }),
    ).rejects.toThrow(/heapBytes/)
  })
})
