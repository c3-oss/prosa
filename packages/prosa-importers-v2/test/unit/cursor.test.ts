// Cursor Provider unit tests (minimal opaque-bytes slice).

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initBundle } from '@c3-oss/prosa-bundle-v2'
import { describe, expect, it } from 'vitest'

import { CursorProvider } from '../../src/cursor/index.js'
import { runCompileImports } from '../../src/orchestrator.js'

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

  it('cheap-identify includes workspace/agent in the logical key (cross-discovery stable)', async () => {
    const root = await tmp()
    await mkdir(join(root, 'ws-1', 'agent-a'), { recursive: true })
    await writeFile(join(root, 'ws-1', 'agent-a', 'store.db'), fakeStoreDb('a'))
    const provider = new CursorProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    const decoded = new TextDecoder().decode(id.logicalKey)
    expect(decoded.startsWith('cursor:ws-1/agent-a:blake3:')).toBe(true)
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
