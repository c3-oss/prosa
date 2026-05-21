// Cursor Provider unit tests.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initBundle } from '@c3-oss/prosa-bundle-v2'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import { CursorProvider } from '../../src/cursor/index.js'
import { runCompileImports } from '../../src/orchestrator.js'

/**
 * Create a real Cursor-shaped SQLite store at `path` with hex-encoded
 * meta JSON in `meta` table and one blob per chat message in `blobs`.
 */
function writeCursorStore(
  path: string,
  meta: Record<string, unknown>,
  blobs: { id: string; payload: unknown | Buffer }[],
): void {
  const db = new Database(path)
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
    `)
    const metaHex = Buffer.from(JSON.stringify(meta), 'utf8').toString('hex')
    db.prepare(`INSERT INTO meta (key, value) VALUES ('0', ?)`).run(metaHex)
    const insert = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)')
    for (const b of blobs) {
      const buf = Buffer.isBuffer(b.payload)
        ? b.payload
        : Buffer.from(typeof b.payload === 'string' ? b.payload : JSON.stringify(b.payload), 'utf8')
      insert.run(b.id, buf)
    }
  } finally {
    db.close()
  }
}

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'prosa-cursor-'))
}

// Fake SQLite header bytes (just enough to look like a real `store.db`
// to the importer's opaque-bytes path).
function fakeStoreDb(seed: string): Uint8Array {
  const header = new TextEncoder().encode('SQLite format 3\0')
  const payload = new TextEncoder().encode(`fake-cursor-store-${seed}`)
  const out = new Uint8Array(header.length + payload.length)
  out.set(header, 0)
  out.set(payload, header.length)
  return out
}

describe('CursorProvider', () => {
  it('discover walks <root>/<workspace>/<agent>/store.db and emits one DiscoveredSourceFile each', async () => {
    const root = await tmp()
    await mkdir(join(root, 'ws-1', 'agent-a'), { recursive: true })
    await writeFile(join(root, 'ws-1', 'agent-a', 'store.db'), fakeStoreDb('a'))
    await mkdir(join(root, 'ws-1', 'agent-b'), { recursive: true })
    await writeFile(join(root, 'ws-1', 'agent-b', 'store.db'), fakeStoreDb('b'))
    await mkdir(join(root, 'ws-2', 'agent-c'), { recursive: true })
    await writeFile(join(root, 'ws-2', 'agent-c', 'store.db'), fakeStoreDb('c'))
    // No store.db here — should be skipped.
    await mkdir(join(root, 'ws-2', 'agent-empty'), { recursive: true })
    const provider = new CursorProvider()
    const files = await provider.discover(root)
    expect(files.length).toBe(3)
    for (const f of files) {
      expect(f.source_tool).toBe('cursor')
      expect(f.file_kind).toBe('session_sqlite')
      expect(f.path.endsWith('store.db')).toBe(true)
    }
  })

  it('CQ-070: cheap-identify uses stable cursor:<workspace>:<agent> as Reserve key (no content hash)', async () => {
    const root = await tmp()
    await mkdir(join(root, 'ws-1', 'agent-a'), { recursive: true })
    await writeFile(join(root, 'ws-1', 'agent-a', 'store.db'), fakeStoreDb('a'))
    const provider = new CursorProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    expect(new TextDecoder().decode(id.logicalKey)).toBe('cursor:ws-1:agent-a')
    // Logical key matches the source_session_id `parseAndProject`
    // assigns: a changed `store.db` for the same (ws, agent) will
    // still Reserve the same row and dedupe correctly.
    const result = await provider.parseAndProject({
      files: [file],
      identification: id,
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    expect(result.unit.projection.sessions[0]!.source_session_id).toBe('cursor:ws-1:agent-a')
  })

  it('parseAndProject emits 1 session + 1 source_file + 1 raw_record (binary_only) per store.db', async () => {
    const root = await tmp()
    await mkdir(join(root, 'ws-1', 'agent-a'), { recursive: true })
    await writeFile(join(root, 'ws-1', 'agent-a', 'store.db'), fakeStoreDb('a'))
    const provider = new CursorProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    const result = await provider.parseAndProject({
      files: [file],
      identification: id,
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    expect(result.summary.sessions).toBe(1)
    expect(result.summary.rawRecords).toBe(1)
    const { projection } = result.unit
    expect(projection.raw_records[0]!.parser_status).toBe('binary_only')
    expect(projection.raw_records[0]!.confidence).toBe('low')
    expect(projection.raw_records[0]!.record_kind).toBe('session_sqlite_row')
    expect(projection.sessions[0]!.timeline_confidence).toBe('low')
    expect(projection.sessions[0]!.source_session_id).toBe('cursor:ws-1:agent-a')
  })

  it('CQ-074: full Cursor projection over a real SQLite store emits MessageV2 + ContentBlockV2 + ToolCallV2 + ToolResultV2', async () => {
    const root = await tmp()
    await mkdir(join(root, 'ws-real', 'agent-x'), { recursive: true })
    const dbPath = join(root, 'ws-real', 'agent-x', 'store.db')
    writeCursorStore(
      dbPath,
      {
        agentId: 'agent-x',
        createdAt: 1735780000000,
        name: 'Test Session',
        mode: 'agent',
        lastUsedModel: 'claude-opus-4',
      },
      [
        {
          id: 'blob-user-1',
          payload: {
            role: 'user',
            id: 'msg-user-1',
            content: 'list the files',
          },
        },
        {
          id: 'blob-asst-1',
          payload: {
            role: 'assistant',
            id: 'msg-asst-1',
            content: [
              { type: 'reasoning', text: 'I should look at the repo root.' },
              { type: 'text', text: "I'll run ls." },
              {
                type: 'tool-call',
                toolCallId: 'tc1',
                toolName: 'run_terminal_cmd',
                args: { command: 'ls /repo' },
              },
            ],
          },
        },
        {
          id: 'blob-tool-1',
          payload: {
            role: 'tool',
            id: 'msg-tool-1',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'tc1',
                result: 'file1\nfile2\n',
              },
            ],
          },
        },
        {
          id: 'blob-protobuf-1',
          // Protobuf-like opaque bytes — should land as binary_only raw_record.
          payload: Buffer.from([0x08, 0x96, 0x01, 0xff, 0xfe]),
        },
      ],
    )
    const provider = new CursorProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    const r = await provider.parseAndProject({
      files: [file],
      identification: id,
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    const p = r.unit.projection
    // 5 raw_records: 1 meta + 4 blobs (3 JSON + 1 binary).
    expect(p.raw_records.length).toBe(5)
    expect(p.raw_records[0]!.json_pointer).toBe('meta/0')
    expect(p.raw_records[0]!.parser_status).toBe('parsed')
    expect(p.raw_records.filter((r) => r.parser_status === 'binary_only').length).toBe(1)
    // 3 messages (user, assistant, tool).
    expect(p.messages.length).toBe(3)
    expect(p.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(p.messages[1]!.model).toBe('claude-opus-4')
    // Content blocks: 1 user text + (reasoning + text + tool_use) + 1 tool_result = 5.
    expect(p.content_blocks.length).toBe(5)
    const reasoning = p.content_blocks.find((b) => b.block_type === 'thinking')
    expect(reasoning?.visibility).toBe('hidden_by_default')
    expect(reasoning?.text_inline).toBe('I should look at the repo root.')
    // 1 tool call from the tool-call content item.
    expect(p.tool_calls.length).toBe(1)
    expect(p.tool_calls[0]!.tool_name).toBe('run_terminal_cmd')
    expect(p.tool_calls[0]!.canonical_tool_type).toBe('shell')
    expect(p.tool_calls[0]!.source_call_id).toBe('tc1')
    expect(p.tool_calls[0]!.command).toBe('ls /repo')
    expect(p.tool_calls[0]!.args_object_id).toMatch(/^blake3:[0-9a-f]{64}$/)
    // 1 tool result linked by source_call_id.
    expect(p.tool_results.length).toBe(1)
    expect(p.tool_results[0]!.tool_call_id).toBe(p.tool_calls[0]!.tool_call_id)
    expect(p.tool_results[0]!.source_call_id).toBe('tc1')
    expect(p.tool_results[0]!.preview).toBe('file1\nfile2\n')
    expect(p.tool_results[0]!.output_object_id).toMatch(/^blake3:[0-9a-f]{64}$/)
    expect(p.tool_results[0]!.is_error).toBe(false)
    expect(p.tool_results[0]!.status).toBe('success')
    // CAS candidates carry the bytes the orchestrator hands to the pool.
    const candidateIds = new Set(r.unit.cas_object_candidates.map((c) => c.object_id))
    expect(candidateIds.has(p.tool_calls[0]!.args_object_id as string)).toBe(true)
    expect(candidateIds.has(p.tool_results[0]!.output_object_id as string)).toBe(true)
    // Session enrichment from meta.
    const s = p.sessions[0]!
    expect(s.title).toBe('Test Session')
    expect(s.agent_nickname).toBe('Test Session')
    expect(s.agent_role).toBe('agent')
    expect(s.model_first).toBe('claude-opus-4')
    expect(s.model_last).toBe('claude-opus-4')
    expect(s.start_ts).toBe(new Date(1735780000000).toISOString())
  })

  it('runCompileImports orchestrates Cursor through a real bundle seal', async () => {
    const bundleRoot = await tmp()
    const discoveryRoot = await tmp()
    await mkdir(join(discoveryRoot, 'ws-1', 'agent-a'), { recursive: true })
    await writeFile(join(discoveryRoot, 'ws-1', 'agent-a', 'store.db'), fakeStoreDb('seal'))
    const bundle = await initBundle(bundleRoot, { storeId: 'st_cursor_e2e', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const result = await runCompileImports({
        bundle,
        providers: [{ provider: new CursorProvider(), root: discoveryRoot }],
        createdAt: '2025-01-02T03:04:06.000Z',
      })
      expect(result.sealedEpoch).toBe(1)
      expect(result.perProvider[0]?.source_tool).toBe('cursor')
      expect(bundle.head.counts.sessions).toBe(1)
      expect(bundle.head.counts.sourceFiles).toBe(1)
      expect(bundle.head.counts.rawRecords).toBe(1)
    } finally {
      await bundle.close()
    }
  })
})
