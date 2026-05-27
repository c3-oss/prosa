import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { writeAllProjectionSegments, writeProjectionSegment } from '../../src/projection/segment-writer.js'

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'prosa-projection-'))
}

function sessionRow(id: string) {
  return {
    session_id: id,
    source_tool: 'codex',
    source_session_id: `src_${id}`,
    project_id: null,
    parent_session_id: null,
    parent_resolution: 'unresolved',
    is_subagent: false,
    agent_role: null,
    agent_nickname: null,
    title: null,
    summary: null,
    start_ts: '2025-01-02T03:04:05.123Z',
    end_ts: null,
    cwd_initial: null,
    git_branch_initial: null,
    model_first: null,
    model_last: null,
    status: null,
    timeline_confidence: 'high',
    raw_record_id: null,
  }
}

describe('writeProjectionSegment', () => {
  it('writes a canonical-NDJSON segment with header + sorted rows', async () => {
    const dir = await tmp()
    const { ref, rowCount } = await writeProjectionSegment(
      'session',
      [sessionRow('ses_b'), sessionRow('ses_a'), sessionRow('ses_c')] as never,
      { outDir: dir },
    )
    expect(rowCount).toBe(3)
    expect(ref.kind).toBe('projection_arrow')
    expect(ref.entityType).toBe('session')
    expect(ref.digest).toMatch(/^blake3:[0-9a-f]{64}$/)
    expect(ref.byteLength).toBeGreaterThan(0)
    const raw = await readFile(ref.path, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    expect(lines.length).toBe(4) // header + 3 rows
    // Rows are sorted ASC by primary key.
    expect(lines[1]).toContain('"session_id":"ses_a"')
    expect(lines[2]).toContain('"session_id":"ses_b"')
    expect(lines[3]).toContain('"session_id":"ses_c"')
  })

  it('produces byte-stable output for identical input regardless of order', async () => {
    const dir1 = await tmp()
    const dir2 = await tmp()
    const rows = [sessionRow('ses_b'), sessionRow('ses_a')]
    const a = await writeProjectionSegment('session', rows as never, { outDir: dir1 })
    const b = await writeProjectionSegment('session', [...rows].reverse() as never, { outDir: dir2 })
    expect(a.ref.digest).toBe(b.ref.digest)
    expect(a.ref.byteLength).toBe(b.ref.byteLength)
  })

  it('handles an empty entity type with a header-only segment', async () => {
    const dir = await tmp()
    const r = await writeProjectionSegment('session', [], { outDir: dir })
    expect(r.rowCount).toBe(0)
    const raw = await readFile(r.ref.path, 'utf8')
    expect(raw.trim().split('\n').length).toBe(1)
  })
})

describe('writeAllProjectionSegments', () => {
  it('writes one segment per non-empty entity type and skips empty ones', async () => {
    const dir = await tmp()
    const refs = await writeAllProjectionSegments(
      {
        session: [sessionRow('ses_a')] as never,
        turn: [],
        message: [],
      },
      { outDir: dir },
    )
    expect(refs.length).toBe(1)
    expect(refs[0]?.ref.entityType).toBe('session')
  })
})
