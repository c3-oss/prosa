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

  it('CQ-074: full Gemini projection emits MessageV2 + ContentBlockV2 + ToolCallV2 + ToolResultV2 + EventV2', async () => {
    const FULL_SESSION = {
      sessionId: 'sess_full',
      startTime: '2025-01-02T03:04:05.123Z',
      lastUpdated: '2025-01-02T03:05:00.000Z',
      messages: [
        { type: 'user', id: 'u1', timestamp: '2025-01-02T03:04:05.500Z', content: 'inspect the repo' },
        {
          type: 'gemini',
          id: 'a1',
          timestamp: '2025-01-02T03:04:06.000Z',
          model: 'gemini-2.5-pro',
          content: [{ type: 'text', text: "I'll list files first." }],
          thoughts: [{ subject: 'plan', description: 'Use ls to inspect the root.' }],
          toolCalls: [
            {
              id: 'tc1',
              name: 'run_shell_command',
              args: { command: 'ls /repo' },
              status: 'success',
              result: [{ text: 'file1\nfile2\n' }],
              timestamp: '2025-01-02T03:04:07.000Z',
            },
          ],
        },
        { type: 'info', id: 'i1', timestamp: '2025-01-02T03:04:08.000Z', content: 'tokens used: 100' },
        { type: 'error', id: 'e1', timestamp: '2025-01-02T03:04:09.000Z', content: 'something failed' },
      ],
    }
    const root = await tmp()
    await mkdir(join(root, 'proj-a', 'chats'), { recursive: true })
    await writeFile(join(root, 'proj-a', '.project_root'), '/repo/proj-a')
    await writeFile(join(root, 'proj-a', 'chats', 'session-001.json'), sessionFile(FULL_SESSION))
    const provider = new GeminiProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    const r = await provider.parseAndProject({
      files: [file],
      identification: id,
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    const p = r.unit.projection
    expect(p.messages.length).toBe(2)
    expect(p.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(p.messages[1]!.model).toBe('gemini-2.5-pro')
    // Content blocks: 1 user text + 1 assistant text + 1 thinking = 3.
    expect(p.content_blocks.length).toBe(3)
    const thinking = p.content_blocks.find((b) => b.block_type === 'thinking')
    expect(thinking?.visibility).toBe('hidden_by_default')
    expect(thinking?.text_inline).toBe('plan\n\nUse ls to inspect the root.')
    expect(p.tool_calls.length).toBe(1)
    expect(p.tool_calls[0]!.tool_name).toBe('run_shell_command')
    expect(p.tool_calls[0]!.canonical_tool_type).toBe('shell')
    expect(p.tool_calls[0]!.source_call_id).toBe('tc1')
    expect(p.tool_calls[0]!.command).toBe('ls /repo')
    expect(p.tool_calls[0]!.args_object_id).toMatch(/^blake3:[0-9a-f]{64}$/)
    expect(p.tool_calls[0]!.status).toBe('success')
    expect(p.tool_results.length).toBe(1)
    expect(p.tool_results[0]!.tool_call_id).toBe(p.tool_calls[0]!.tool_call_id)
    expect(p.tool_results[0]!.source_call_id).toBe('tc1')
    expect(p.tool_results[0]!.preview).toBe('file1\nfile2\n')
    expect(p.tool_results[0]!.output_object_id).toMatch(/^blake3:[0-9a-f]{64}$/)
    expect(p.tool_results[0]!.is_error).toBe(false)
    expect(p.tool_results[0]!.status).toBe('success')
    const candidateIds = new Set(r.unit.cas_object_candidates.map((c) => c.object_id))
    expect(candidateIds.has(p.tool_calls[0]!.args_object_id as string)).toBe(true)
    expect(candidateIds.has(p.tool_results[0]!.output_object_id as string)).toBe(true)
    // 2 events: info → system_operational, error → error.
    expect(p.events.length).toBe(2)
    const eventTypes = p.events.map((e) => e.event_type).sort()
    expect(eventTypes).toEqual(['error', 'system_operational'])
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
