// Codex Provider unit tests.
//
// Covers the load-bearing paths:
//   - discovery walks a Codex-shape sessions tree
//   - cheap-identify derives the same logical key for two paths
//     pointing at the same session_meta.id
//   - parseAndProject emits one SessionV2 + one SourceFileV2 + one
//     RawRecordV2 per JSONL line, with content_hash + object_id
//     equal to blake3 of the file bytes
//   - the orchestrator backfills source_file pack metadata correctly
//     when running through `runCompileImports`

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initBundle } from '@c3-oss/prosa-bundle-v2'
import { toHex } from '@c3-oss/prosa-types-v2'
import { blake3 } from '@noble/hashes/blake3'
import { describe, expect, it } from 'vitest'

import { CodexProvider } from '../../src/codex/index.js'
import { runCompileImports } from '../../src/orchestrator.js'

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'prosa-codex-'))
}

const SAMPLE_ENVELOPES = [
  {
    type: 'session_meta',
    timestamp: '2025-01-02T03:04:05.123Z',
    payload: {
      id: 'sess_abc123',
      cwd: '/repo',
      cli_version: '1.0.0',
    },
  },
  {
    type: 'turn_context',
    timestamp: '2025-01-02T03:04:06.000Z',
    payload: { turn_id: 'turn_001', cwd: '/repo', model: 'gpt-4o' },
  },
  {
    type: 'response_item',
    timestamp: '2025-01-02T03:04:07.000Z',
    payload: { role: 'user', text: 'hello' },
  },
]

function jsonlBytes(envelopes: readonly unknown[]): Uint8Array {
  const body = `${envelopes.map((e) => JSON.stringify(e)).join('\n')}\n`
  return new TextEncoder().encode(body)
}

describe('CodexProvider', () => {
  it('discover walks YYYY/MM/DD jsonl tree and emits one DiscoveredSourceFile per *.jsonl', async () => {
    const root = await tmp()
    await mkdir(join(root, '2025', '01', '02'), { recursive: true })
    const bytes = jsonlBytes(SAMPLE_ENVELOPES)
    await writeFile(join(root, '2025', '01', '02', 'rollout-1.jsonl'), bytes)
    await writeFile(join(root, '2025', '01', '02', 'rollout-2.jsonl'), bytes)
    // Non-jsonl files are skipped.
    await writeFile(join(root, 'README.md'), 'ignore me')
    const provider = new CodexProvider()
    const files = await provider.discover(root)
    expect(files.length).toBe(2)
    expect(files[0]!.source_tool).toBe('codex')
    expect(files[0]!.file_kind).toBe('session_jsonl')
    expect(files[0]!.source_file_id).toMatch(/^src_[a-z0-9_:-]+$/)
    // Same bytes → same source_file_id (via deriveSourceFileId, which
    // includes the path — so two different paths produce different
    // ids even with identical bytes).
    expect(files[0]!.source_file_id).not.toBe(files[1]!.source_file_id)
  })

  it('cheap-identify returns a session-scoped logical key derived from session_meta.id', async () => {
    const root = await tmp()
    const bytes = jsonlBytes(SAMPLE_ENVELOPES)
    const path = join(root, 'rollout.jsonl')
    await writeFile(path, bytes)
    const provider = new CodexProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    expect(id.logical_kind).toBe('session')
    expect(new TextDecoder().decode(id.logicalKey)).toBe('codex:sess_abc123')
    expect(id.unit_id).toBe(`unit_${file.source_file_id}`)
  })

  it('cheap-identify falls back to source_file_id when no session_meta envelope exists', async () => {
    const root = await tmp()
    const bytes = jsonlBytes([SAMPLE_ENVELOPES[1], SAMPLE_ENVELOPES[2]])
    const path = join(root, 'rollout-no-meta.jsonl')
    await writeFile(path, bytes)
    const provider = new CodexProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    expect(new TextDecoder().decode(id.logicalKey)).toBe(`codex:src:${file.source_file_id}`)
  })

  it('CQ-074: full Codex projection emits TurnV2 + MessageV2 + ContentBlockV2 + ToolCallV2 + ToolResultV2 + EventV2', async () => {
    const root = await tmp()
    const envelopes = [
      {
        type: 'session_meta',
        timestamp: '2025-01-02T03:04:05.123Z',
        payload: { id: 'sess_full', cwd: '/repo', cli_version: '2.0' },
      },
      {
        type: 'turn_context',
        timestamp: '2025-01-02T03:04:06.000Z',
        payload: {
          turn_id: 'turn_001',
          cwd: '/repo',
          model: 'gpt-5-turbo',
          effort: 'medium',
          approval_policy: 'on_request',
          sandbox_policy: { mode: 'workspace-write' },
        },
      },
      {
        type: 'response_item',
        timestamp: '2025-01-02T03:04:07.000Z',
        payload: {
          id: 'msg_user_1',
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'find the bug' }],
        },
      },
      {
        type: 'response_item',
        timestamp: '2025-01-02T03:04:08.000Z',
        payload: {
          id: 'msg_asst_1',
          type: 'message',
          role: 'assistant',
          model: 'gpt-5-turbo',
          parent_message_id: 'msg_user_1',
          content: [
            { type: 'reasoning', thinking: 'examining the code' },
            { type: 'output_text', text: 'I see the bug.' },
          ],
        },
      },
      {
        type: 'response_item',
        timestamp: '2025-01-02T03:04:09.000Z',
        payload: {
          type: 'function_call',
          call_id: 'call_abc',
          name: 'shell',
          arguments: { command: ['grep', '-rn', 'foo'] },
          status: 'in_progress',
        },
      },
      {
        type: 'response_item',
        timestamp: '2025-01-02T03:04:10.000Z',
        payload: {
          type: 'function_call_output',
          call_id: 'call_abc',
          output: 'src/foo.ts:42:foo()',
          status: 'completed',
        },
      },
      {
        type: 'event_msg',
        timestamp: '2025-01-02T03:04:11.000Z',
        payload: { id: 'ev_1', subtype: 'token_usage', actor: 'cli' },
      },
    ]
    await writeFile(join(root, 'rollout-full.jsonl'), jsonlBytes(envelopes))
    const provider = new CodexProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    const r = await provider.parseAndProject({
      files: [file],
      identification: id,
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    const p = r.unit.projection
    expect(p.turns.length).toBe(1)
    expect(p.turns[0]!.source_turn_id).toBe('turn_001')
    expect(p.turns[0]!.model).toBe('gpt-5-turbo')
    expect(p.turns[0]!.sandbox_policy).toBe('workspace-write')
    expect(p.turns[0]!.approval_policy).toBe('on_request')
    expect(p.messages.length).toBe(2)
    expect(p.messages[0]!.role).toBe('user')
    expect(p.messages[1]!.role).toBe('assistant')
    expect(p.messages[1]!.parent_message_id).toBe(p.messages[0]!.message_id)
    expect(p.content_blocks.length).toBe(3) // 1 user text + 2 assistant blocks
    const reasoning = p.content_blocks.find((b) => b.block_type === 'reasoning')
    expect(reasoning?.visibility).toBe('hidden_by_default')
    expect(reasoning?.text_inline).toBe('examining the code')
    expect(p.tool_calls.length).toBe(1)
    expect(p.tool_calls[0]!.tool_name).toBe('shell')
    expect(p.tool_calls[0]!.source_call_id).toBe('call_abc')
    expect(p.tool_calls[0]!.command).toBe('grep -rn foo')
    expect(p.tool_calls[0]!.args_object_id).toBeNull()
    expect(p.tool_calls[0]!.status).toBe('in_progress')
    expect(p.tool_results.length).toBe(1)
    expect(p.tool_results[0]!.tool_call_id).toBe(p.tool_calls[0]!.tool_call_id)
    expect(p.tool_results[0]!.source_call_id).toBe('call_abc')
    expect(p.tool_results[0]!.preview).toBe('src/foo.ts:42:foo()')
    expect(p.tool_results[0]!.output_object_id).toBeNull()
    expect(p.tool_results[0]!.is_error).toBe(false)
    expect(p.events.length).toBe(1)
    expect(p.events[0]!.event_type).toBe('token_usage')
    expect(p.events[0]!.turn_id).toBe(p.turns[0]!.turn_id)
    // Session fields enriched from turn_context/response_item.
    expect(p.sessions[0]!.cwd_initial).toBe('/repo')
    expect(p.sessions[0]!.model_first).toBe('gpt-5-turbo')
    expect(p.sessions[0]!.model_last).toBe('gpt-5-turbo')
  })

  it('parseAndProject emits 1 session + 1 source_file + one raw_record per line', async () => {
    const root = await tmp()
    const bytes = jsonlBytes(SAMPLE_ENVELOPES)
    const path = join(root, 'rollout.jsonl')
    await writeFile(path, bytes)
    const provider = new CodexProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    const result = await provider.parseAndProject({
      files: [file],
      identification: id,
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    expect(result.summary.sessions).toBe(1)
    expect(result.summary.files).toBe(1)
    expect(result.summary.rawRecords).toBe(SAMPLE_ENVELOPES.length)
    const { projection } = result.unit
    expect(projection.sessions.length).toBe(1)
    expect(projection.source_files.length).toBe(1)
    expect(projection.raw_records.length).toBe(SAMPLE_ENVELOPES.length)
    const session = projection.sessions[0]!
    expect(session.source_session_id).toBe('sess_abc123')
    expect(session.start_ts).toBe('2025-01-02T03:04:05.123Z')
    const contentHash = `blake3:${toHex(blake3(bytes))}`
    expect(projection.source_files[0]!.content_hash).toBe(contentHash)
    expect(projection.source_files[0]!.object_id).toBe(contentHash)
    expect(projection.raw_records[0]!.content_hash).toBe(contentHash)
    expect(projection.raw_records[0]!.parser_status).toBe('parsed')
    expect(projection.raw_records[0]!.ordinal).toBe(0)
  })

  it('parseAndProject marks unparseable lines as parser_status="corrupt" with confidence="low"', async () => {
    const root = await tmp()
    // Mix valid + malformed JSON lines.
    const body = `${JSON.stringify(SAMPLE_ENVELOPES[0])}\nnot valid json\n${JSON.stringify(SAMPLE_ENVELOPES[2])}\n`
    const path = join(root, 'rollout-mixed.jsonl')
    await writeFile(path, new TextEncoder().encode(body))
    const provider = new CodexProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    const result = await provider.parseAndProject({
      files: [file],
      identification: id,
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    expect(result.unit.projection.raw_records.length).toBe(3)
    expect(result.unit.projection.raw_records[1]!.parser_status).toBe('unparseable')
    expect(result.unit.projection.raw_records[1]!.confidence).toBe('low')
    // Surrounding lines still parsed cleanly.
    expect(result.unit.projection.raw_records[0]!.parser_status).toBe('parsed')
    expect(result.unit.projection.raw_records[2]!.parser_status).toBe('parsed')
  })

  it('runCompileImports orchestrates Codex through a real bundle seal', async () => {
    const bundleRoot = await tmp()
    const discoveryRoot = await tmp()
    await mkdir(join(discoveryRoot, '2025', '01', '02'), { recursive: true })
    const bytes = jsonlBytes(SAMPLE_ENVELOPES)
    await writeFile(join(discoveryRoot, '2025', '01', '02', 'rollout-real.jsonl'), bytes)
    const bundle = await initBundle(bundleRoot, { storeId: 'st_codex_e2e', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const result = await runCompileImports({
        bundle,
        providers: [{ provider: new CodexProvider(), root: discoveryRoot }],
        createdAt: '2025-01-02T03:04:06.000Z',
      })
      expect(result.sealedEpoch).toBe(1)
      expect(result.perProvider[0]?.source_tool).toBe('codex')
      expect(result.perProvider[0]?.discovered).toBe(1)
      expect(result.perProvider[0]?.won).toBe(1)
      expect(result.perProvider[0]?.lost).toBe(0)
      expect(bundle.head.epoch).toBe(1)
      expect(bundle.head.counts.sessions).toBe(1)
      expect(bundle.head.counts.sourceFiles).toBe(1)
      expect(bundle.head.counts.rawRecords).toBe(SAMPLE_ENVELOPES.length)
    } finally {
      await bundle.close()
    }
  })
})
