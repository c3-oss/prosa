// readSearchDocSegment tests.
//
// Cover the happy path (header + N rows, rowids assigned by position),
// missing-segment tolerance (returns null), malformed-input rejection,
// and the SearchDocV2 -> SearchDocInputV2 field mapping (notably the
// `errors_only` drop).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readSearchDocSegment, searchDocSegmentPath } from '../../src/tantivy/projection-reader.js'

async function plantSegment(bundleRoot: string, epoch: number, body: string): Promise<string> {
  const path = searchDocSegmentPath(bundleRoot, epoch)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, 'utf-8')
  return path
}

describe('readSearchDocSegment', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-projection-reader-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns null when no projection segment exists for the epoch', async () => {
    const out = await readSearchDocSegment(bundleRoot, 0)
    expect(out).toBeNull()
  })

  it('parses the header + body rows and assigns sequential rowids', async () => {
    const header = JSON.stringify({
      bundleFormat: 2,
      segmentKind: 'projection_ndjson',
      entityType: 'search_doc',
      rowCount: 2,
    })
    const row1 = JSON.stringify({
      doc_id: 'doc-a',
      entity_type: 'message',
      entity_id: 'msg-1',
      session_id: 'ses_1',
      project_id: 'proj_1',
      timestamp: '2026-05-20T00:00:00Z',
      role: 'user',
      tool_name: null,
      canonical_tool_type: null,
      field_kind: 'message_text',
      errors_only: false,
      text: 'hello',
    })
    const row2 = JSON.stringify({
      doc_id: 'doc-b',
      entity_type: 'message',
      entity_id: 'msg-2',
      session_id: null,
      project_id: null,
      timestamp: null,
      role: null,
      tool_name: null,
      canonical_tool_type: null,
      field_kind: 'assistant_text',
      errors_only: true,
      text: 'world',
    })
    await plantSegment(bundleRoot, 0, `${header}\n${row1}\n${row2}\n`)
    const out = await readSearchDocSegment(bundleRoot, 0)
    expect(out).not.toBeNull()
    if (out === null) throw new Error('unreachable')
    expect(out.sourceDocCount).toBe(2)
    expect(out.maxRowid).toBe(2)
    expect(out.rows[0]?.rowid).toBe(1)
    expect(out.rows[1]?.rowid).toBe(2)
    expect(out.rows[0]?.doc_id).toBe('doc-a')
    expect(out.rows[1]?.session_id).toBeNull()
    // SearchDocInputV2 deliberately omits `errors_only`; the mapper
    // drops it so the Tantivy schema does not need a sibling field.
    expect((out.rows[1] as unknown as Record<string, unknown>).errors_only).toBeUndefined()
  })

  it('throws when a body row is missing doc_id', async () => {
    const header = JSON.stringify({
      bundleFormat: 2,
      segmentKind: 'projection_ndjson',
      entityType: 'search_doc',
      rowCount: 1,
    })
    const bad = JSON.stringify({ entity_type: 'message', text: 'no id' })
    await plantSegment(bundleRoot, 0, `${header}\n${bad}\n`)
    await expect(readSearchDocSegment(bundleRoot, 0)).rejects.toThrow(/missing required doc_id/)
  })

  it('throws when a body line is not valid JSON', async () => {
    const header = JSON.stringify({
      bundleFormat: 2,
      segmentKind: 'projection_ndjson',
      entityType: 'search_doc',
      rowCount: 1,
    })
    await plantSegment(bundleRoot, 0, `${header}\n{not valid json\n`)
    await expect(readSearchDocSegment(bundleRoot, 0)).rejects.toThrow(/not valid JSON/)
  })

  it('throws when the segment file is empty', async () => {
    await plantSegment(bundleRoot, 0, '')
    await expect(readSearchDocSegment(bundleRoot, 0)).rejects.toThrow(/missing header/)
  })
})
