// Gemini CLI Provider unit tests.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initBundle } from '@c3-oss/prosa-bundle-v2'
import { describe, expect, it } from 'vitest'

import { GeminiProvider } from '../../src/gemini/index.js'
import { runCompileImports } from '../../src/orchestrator.js'

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'prosa-gemini-'))
}

const SAMPLE_SESSION = {
  sessionId: 'sess_gem_001',
  projectHash: 'abc123',
  startTime: '2025-01-02T03:04:05.123Z',
  lastUpdated: '2025-01-02T03:05:00.000Z',
  summary: 'demo session',
  messages: [
    { type: 'user', id: 'm1', timestamp: '2025-01-02T03:04:05.500Z', content: 'hi' },
    { type: 'gemini', id: 'm2', timestamp: '2025-01-02T03:04:06.000Z', model: 'gemini-2.5-pro', content: 'hello' },
    { type: 'gemini', id: 'm3', timestamp: '2025-01-02T03:04:07.000Z', model: 'gemini-2.5-pro', content: 'thinking…' },
  ],
}

function sessionFile(payload: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload, null, 2))
}

describe('GeminiProvider', () => {
  it('discover walks <root>/<projectDir>/chats/session-*.json and emits one DiscoveredSourceFile each', async () => {
    const root = await tmp()
    await mkdir(join(root, 'proj-a', 'chats'), { recursive: true })
    await writeFile(join(root, 'proj-a', '.project_root'), '/repo/proj-a\n')
    await writeFile(join(root, 'proj-a', 'chats', 'session-001.json'), sessionFile(SAMPLE_SESSION))
    await writeFile(
      join(root, 'proj-a', 'chats', 'session-002.json'),
      sessionFile({ ...SAMPLE_SESSION, sessionId: 'sess_gem_002' }),
    )
    // Skipped: bin/ and non-session files.
    await mkdir(join(root, 'bin'), { recursive: true })
    await writeFile(join(root, 'proj-a', 'chats', 'logs.json'), '{}')
    const provider = new GeminiProvider()
    const files = await provider.discover(root)
    expect(files.length).toBe(2)
    expect(files[0]!.source_tool).toBe('gemini')
    expect(files[0]!.file_kind).toBe('session_json')
  })

  it('cheap-identify uses sessionId as the canonical Reserve key', async () => {
    const root = await tmp()
    await mkdir(join(root, 'proj-a', 'chats'), { recursive: true })
    await writeFile(join(root, 'proj-a', 'chats', 'session-001.json'), sessionFile(SAMPLE_SESSION))
    const provider = new GeminiProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    expect(new TextDecoder().decode(id.logicalKey)).toBe('gemini:sess_gem_001')
  })

  it('parseAndProject emits one raw_record per messages[] entry + populates session start/end/model/summary', async () => {
    const root = await tmp()
    await mkdir(join(root, 'proj-a', 'chats'), { recursive: true })
    await writeFile(join(root, 'proj-a', '.project_root'), '/repo/proj-a')
    await writeFile(join(root, 'proj-a', 'chats', 'session-001.json'), sessionFile(SAMPLE_SESSION))
    const provider = new GeminiProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    const result = await provider.parseAndProject({
      files: [file],
      identification: id,
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    expect(result.summary.rawRecords).toBe(SAMPLE_SESSION.messages.length)
    const { projection } = result.unit
    const session = projection.sessions[0]!
    expect(session.source_session_id).toBe('sess_gem_001')
    expect(session.start_ts).toBe('2025-01-02T03:04:05.123Z')
    expect(session.end_ts).toBe('2025-01-02T03:05:00.000Z')
    expect(session.summary).toBe('demo session')
    expect(session.model_first).toBe('gemini-2.5-pro')
    expect(session.model_last).toBe('gemini-2.5-pro')
    expect(session.cwd_initial).toBe('/repo/proj-a')
    expect(projection.raw_records[0]!.json_pointer).toBe('/messages/0')
    expect(projection.raw_records[2]!.json_pointer).toBe('/messages/2')
  })

  it('parseAndProject still preserves bytes when the JSON is corrupt (one raw_record, parser_status=unparseable)', async () => {
    const root = await tmp()
    await mkdir(join(root, 'proj-a', 'chats'), { recursive: true })
    await writeFile(join(root, 'proj-a', 'chats', 'session-001.json'), new TextEncoder().encode('not valid json'))
    const provider = new GeminiProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    const result = await provider.parseAndProject({
      files: [file],
      identification: id,
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    expect(result.summary.rawRecords).toBe(1)
    expect(result.unit.projection.raw_records[0]!.parser_status).toBe('unparseable')
    expect(result.unit.projection.raw_records[0]!.confidence).toBe('low')
  })

  it('runCompileImports orchestrates Gemini through a real bundle seal', async () => {
    const bundleRoot = await tmp()
    const discoveryRoot = await tmp()
    await mkdir(join(discoveryRoot, 'proj-a', 'chats'), { recursive: true })
    await writeFile(join(discoveryRoot, 'proj-a', 'chats', 'session-001.json'), sessionFile(SAMPLE_SESSION))
    const bundle = await initBundle(bundleRoot, { storeId: 'st_gem_e2e', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const result = await runCompileImports({
        bundle,
        providers: [{ provider: new GeminiProvider(), root: discoveryRoot }],
        createdAt: '2025-01-02T03:04:06.000Z',
      })
      expect(result.sealedEpoch).toBe(1)
      expect(result.perProvider[0]?.source_tool).toBe('gemini')
      expect(bundle.head.counts.sessions).toBe(1)
      expect(bundle.head.counts.sourceFiles).toBe(1)
      expect(bundle.head.counts.rawRecords).toBe(SAMPLE_SESSION.messages.length)
    } finally {
      await bundle.close()
    }
  })
})
