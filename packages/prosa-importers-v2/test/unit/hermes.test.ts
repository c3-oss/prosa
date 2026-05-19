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

  it('CQ-074: full Hermes projection emits MessageV2 + ContentBlockV2 + ToolCallV2 + ToolResultV2 + EventV2', async () => {
    const FULL_JSONL = [
      // session_meta → EventV2
      {
        session_id: 'sess_full',
        role: 'session_meta',
        id: 'm0',
        timestamp: '2025-01-02T03:04:05.123Z',
        model: 'gpt-4o',
      },
      // user message → MessageV2 + ContentBlockV2
      {
        session_id: 'sess_full',
        role: 'user',
        id: 'm1',
        timestamp: '2025-01-02T03:04:06.000Z',
        content: 'list the files',
      },
      // assistant with reasoning + tool_calls → MessageV2 + ContentBlockV2 (text + hidden reasoning) + ToolCallV2
      {
        session_id: 'sess_full',
        role: 'assistant',
        id: 'm2',
        timestamp: '2025-01-02T03:04:07.000Z',
        model: 'gpt-4o',
        content: "I'll list them now.",
        reasoning: 'Choose a quick listing strategy.',
        tool_calls: [{ id: 'tc1', function: { name: 'run_shell_command', arguments: { command: 'ls /repo' } } }],
      },
      // tool result envelope → MessageV2 (role=tool) + ToolResultV2 linked back by tool_call_id
      {
        session_id: 'sess_full',
        role: 'tool',
        id: 'm3',
        timestamp: '2025-01-02T03:04:08.000Z',
        tool_call_id: 'tc1',
        tool_name: 'run_shell_command',
        content: 'file1\nfile2\n',
      },
    ]
    const root = await tmp()
    await writeFile(join(root, 'sess_full.jsonl'), jsonlBytes(FULL_JSONL))
    const provider = new HermesProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    const r = await provider.parseAndProject({
      files: [file],
      identification: id,
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    const p = r.unit.projection
    // 3 messages (user, assistant, tool); session_meta → event.
    expect(p.messages.length).toBe(3)
    expect(p.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(p.messages[1]!.model).toBe('gpt-4o')
    // 1 event from session_meta.
    expect(p.events.length).toBe(1)
    expect(p.events[0]!.source_type).toBe('session_meta')
    // Content blocks: user text + assistant text + assistant reasoning (hidden) + tool text = 4.
    expect(p.content_blocks.length).toBe(4)
    const reasoning = p.content_blocks.find((b) => b.block_type === 'reasoning')
    expect(reasoning?.visibility).toBe('hidden_by_default')
    expect(reasoning?.text_inline).toBe('Choose a quick listing strategy.')
    // 1 tool call from assistant.tool_calls[].
    expect(p.tool_calls.length).toBe(1)
    expect(p.tool_calls[0]!.tool_name).toBe('run_shell_command')
    expect(p.tool_calls[0]!.canonical_tool_type).toBe('shell')
    expect(p.tool_calls[0]!.source_call_id).toBe('tc1')
    expect(p.tool_calls[0]!.command).toBe('ls /repo')
    expect(p.tool_calls[0]!.args_object_id).toBeNull()
    // 1 tool result linked by source_call_id.
    expect(p.tool_results.length).toBe(1)
    expect(p.tool_results[0]!.tool_call_id).toBe(p.tool_calls[0]!.tool_call_id)
    expect(p.tool_results[0]!.source_call_id).toBe('tc1')
    expect(p.tool_results[0]!.preview).toBe('file1\nfile2\n')
    expect(p.tool_results[0]!.is_error).toBe(false)
    expect(p.tool_results[0]!.status).toBe('success')
    // Session model accumulated across the per-record pass.
    expect(p.sessions[0]!.model_first).toBe('gpt-4o')
    expect(p.sessions[0]!.model_last).toBe('gpt-4o')
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
