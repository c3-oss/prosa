// Hermes Provider unit tests (minimal slice).

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initBundle } from '@c3-oss/prosa-bundle-v2'
import { describe, expect, it } from 'vitest'

import { HermesProvider } from '../../src/hermes/index.js'
import { runCompileImports } from '../../src/orchestrator.js'

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'prosa-hermes-'))
}

const JSONL_LINES = [
  { session_id: 'sess_hm_001', type: 'meta', timestamp: '2025-01-02T03:04:05.123Z', model: 'gpt-4o' },
  { session_id: 'sess_hm_001', type: 'user', timestamp: '2025-01-02T03:04:06.000Z', content: 'hi' },
  { session_id: 'sess_hm_001', type: 'assistant', timestamp: '2025-01-02T03:04:07.000Z', content: 'hello' },
]

function jsonlBytes(lines: readonly unknown[]): Uint8Array {
  return new TextEncoder().encode(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
}

const JSON_SNAPSHOT = {
  session_id: 'sess_hm_json_002',
  start_time: '2025-01-02T03:04:05.123Z',
  end_time: '2025-01-02T03:05:00.000Z',
  model: 'gpt-4o',
  summary: 'JSON snapshot session',
  messages: [
    { type: 'user', timestamp: '2025-01-02T03:04:05.500Z', content: 'hi' },
    { type: 'assistant', timestamp: '2025-01-02T03:04:06.000Z', content: 'hello' },
  ],
}

describe('HermesProvider', () => {
  it('discover walks <root> and emits one entry per *.jsonl + session_*.json (skips sessions.json)', async () => {
    const root = await tmp()
    await writeFile(join(root, 'sess_hm_001.jsonl'), jsonlBytes(JSONL_LINES))
    await writeFile(join(root, 'session_002.json'), new TextEncoder().encode(JSON.stringify(JSON_SNAPSHOT)))
    await writeFile(join(root, 'sessions.json'), '{"ignore":"index"}')
    await writeFile(join(root, 'notes.md'), 'ignored')
    const provider = new HermesProvider()
    const files = await provider.discover(root)
    expect(files.length).toBe(2)
    const kinds = files.map((f) => f.file_kind).sort()
    expect(kinds).toEqual(['session_json', 'session_jsonl'])
  })

  it('cheap-identify uses session_id from the first JSONL envelope', async () => {
    const root = await tmp()
    await writeFile(join(root, 'sess_hm_001.jsonl'), jsonlBytes(JSONL_LINES))
    const provider = new HermesProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    expect(new TextDecoder().decode(id.logicalKey)).toBe('hermes:sess_hm_001')
  })

  it('cheap-identify uses snapshot.session_id from JSON snapshots', async () => {
    const root = await tmp()
    await writeFile(join(root, 'session_002.json'), new TextEncoder().encode(JSON.stringify(JSON_SNAPSHOT)))
    const provider = new HermesProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    expect(new TextDecoder().decode(id.logicalKey)).toBe('hermes:sess_hm_json_002')
  })

  it('parseAndProject (jsonl) emits one raw_record per line + session start/end/model', async () => {
    const root = await tmp()
    await writeFile(join(root, 'sess_hm_001.jsonl'), jsonlBytes(JSONL_LINES))
    const provider = new HermesProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    const result = await provider.parseAndProject({
      files: [file],
      identification: id,
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    expect(result.summary.rawRecords).toBe(JSONL_LINES.length)
    const s = result.unit.projection.sessions[0]!
    expect(s.source_session_id).toBe('sess_hm_001')
    expect(s.start_ts).toBe('2025-01-02T03:04:05.123Z')
    expect(s.end_ts).toBe('2025-01-02T03:04:07.000Z')
    expect(s.model_first).toBe('gpt-4o')
  })

  it('parseAndProject (json snapshot) emits one raw_record per messages[] entry + summary/start_time/end_time', async () => {
    const root = await tmp()
    await writeFile(join(root, 'session_002.json'), new TextEncoder().encode(JSON.stringify(JSON_SNAPSHOT)))
    const provider = new HermesProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    const result = await provider.parseAndProject({
      files: [file],
      identification: id,
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    expect(result.summary.rawRecords).toBe(JSON_SNAPSHOT.messages.length)
    const s = result.unit.projection.sessions[0]!
    expect(s.source_session_id).toBe('sess_hm_json_002')
    expect(s.start_ts).toBe('2025-01-02T03:04:05.123Z')
    expect(s.end_ts).toBe('2025-01-02T03:05:00.000Z')
    expect(s.summary).toBe('JSON snapshot session')
  })

  it('runCompileImports orchestrates Hermes (mixed jsonl + json) through a real bundle seal', async () => {
    const bundleRoot = await tmp()
    const discoveryRoot = await tmp()
    await writeFile(join(discoveryRoot, 'sess_hm_001.jsonl'), jsonlBytes(JSONL_LINES))
    await writeFile(join(discoveryRoot, 'session_002.json'), new TextEncoder().encode(JSON.stringify(JSON_SNAPSHOT)))
    const bundle = await initBundle(bundleRoot, { storeId: 'st_hm_e2e', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const result = await runCompileImports({
        bundle,
        providers: [{ provider: new HermesProvider(), root: discoveryRoot }],
        createdAt: '2025-01-02T03:04:06.000Z',
      })
      expect(result.sealedEpoch).toBe(1)
      expect(bundle.head.counts.sessions).toBe(2)
      expect(bundle.head.counts.sourceFiles).toBe(2)
      expect(bundle.head.counts.rawRecords).toBe(JSONL_LINES.length + JSON_SNAPSHOT.messages.length)
    } finally {
      await bundle.close()
    }
  })
})
