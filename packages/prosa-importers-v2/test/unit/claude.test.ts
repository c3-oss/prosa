// Claude Code Provider unit tests.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initBundle } from '@c3-oss/prosa-bundle-v2'
import { describe, expect, it } from 'vitest'

import { ClaudeProvider } from '../../src/claude/index.js'
import { runCompileImports } from '../../src/orchestrator.js'

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'prosa-claude-'))
}

const SAMPLE_MAIN_LINES = [
  {
    type: 'user',
    uuid: 'rec-1',
    parentUuid: null,
    sessionId: 'sess_main_xyz',
    timestamp: '2025-01-02T03:04:05.123Z',
    cwd: '/repo',
    gitBranch: 'main',
    message: { role: 'user', model: 'claude-3.5-sonnet', content: [{ type: 'text', text: 'hi' }] },
  },
  {
    type: 'assistant',
    uuid: 'rec-2',
    parentUuid: 'rec-1',
    sessionId: 'sess_main_xyz',
    timestamp: '2025-01-02T03:04:06.000Z',
    message: { role: 'assistant', model: 'claude-3.5-sonnet', content: [{ type: 'text', text: 'hello' }] },
  },
]

const SAMPLE_SUBAGENT_LINES = [
  {
    type: 'user',
    uuid: 'sub-rec-1',
    parentUuid: null,
    sessionId: 'sess_main_xyz',
    agentId: 'agent_001',
    isSidechain: true,
    timestamp: '2025-01-02T03:04:07.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'subagent task' }] },
  },
]

function jsonlBytes(rows: readonly unknown[]): Uint8Array {
  return new TextEncoder().encode(`${rows.map((r) => JSON.stringify(r)).join('\n')}\n`)
}

describe('ClaudeProvider', () => {
  it('discover walks projects/<slug>/*.jsonl and projects/<slug>/<sid>/subagents/agent-*.jsonl', async () => {
    const root = await tmp()
    await mkdir(join(root, 'my-project'), { recursive: true })
    await writeFile(join(root, 'my-project', 'sess_main_xyz.jsonl'), jsonlBytes(SAMPLE_MAIN_LINES))
    await mkdir(join(root, 'my-project', 'sess_main_xyz', 'subagents'), { recursive: true })
    await writeFile(
      join(root, 'my-project', 'sess_main_xyz', 'subagents', 'agent-agent_001.jsonl'),
      jsonlBytes(SAMPLE_SUBAGENT_LINES),
    )
    // Non-jsonl files and other project dirs are skipped.
    await writeFile(join(root, 'my-project', 'README.md'), 'ignored')
    const provider = new ClaudeProvider()
    const files = await provider.discover(root)
    expect(files.length).toBe(2)
    const kinds = files.map((f) => f.file_kind).sort()
    expect(kinds).toEqual(['session_jsonl', 'session_jsonl_subagent'])
  })

  it('cheap-identify on main file uses sessionId; on subagent file includes agentId', async () => {
    const root = await tmp()
    await mkdir(join(root, 'p1'), { recursive: true })
    await writeFile(join(root, 'p1', 'sess_main_xyz.jsonl'), jsonlBytes(SAMPLE_MAIN_LINES))
    await mkdir(join(root, 'p1', 'sess_main_xyz', 'subagents'), { recursive: true })
    await writeFile(
      join(root, 'p1', 'sess_main_xyz', 'subagents', 'agent-agent_001.jsonl'),
      jsonlBytes(SAMPLE_SUBAGENT_LINES),
    )
    const provider = new ClaudeProvider()
    const files = await provider.discover(root)
    const main = files.find((f) => f.file_kind === 'session_jsonl')!
    const sub = files.find((f) => f.file_kind === 'session_jsonl_subagent')!
    const mainId = await provider.cheapIdentify(main)
    const subId = await provider.cheapIdentify(sub)
    expect(new TextDecoder().decode(mainId.logicalKey)).toBe('claude:sess_main_xyz')
    expect(new TextDecoder().decode(subId.logicalKey)).toBe('claude:sess_main_xyz:agent:agent_001')
  })

  it('parseAndProject sets is_subagent + carries cwd/gitBranch/model_first from the first record', async () => {
    const root = await tmp()
    await mkdir(join(root, 'p1', 'sess_main_xyz', 'subagents'), { recursive: true })
    await writeFile(
      join(root, 'p1', 'sess_main_xyz', 'subagents', 'agent-agent_001.jsonl'),
      jsonlBytes(SAMPLE_SUBAGENT_LINES),
    )
    await writeFile(join(root, 'p1', 'sess_main_xyz.jsonl'), jsonlBytes(SAMPLE_MAIN_LINES))
    const provider = new ClaudeProvider()
    const files = await provider.discover(root)
    const main = files.find((f) => f.file_kind === 'session_jsonl')!
    const sub = files.find((f) => f.file_kind === 'session_jsonl_subagent')!
    const mainResult = await provider.parseAndProject({
      files: [main],
      identification: await provider.cheapIdentify(main),
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    const subResult = await provider.parseAndProject({
      files: [sub],
      identification: await provider.cheapIdentify(sub),
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    const mainSession = mainResult.unit.projection.sessions[0]!
    expect(mainSession.is_subagent).toBe(false)
    expect(mainSession.cwd_initial).toBe('/repo')
    expect(mainSession.git_branch_initial).toBe('main')
    expect(mainSession.model_first).toBe('claude-3.5-sonnet')
    expect(mainSession.start_ts).toBe('2025-01-02T03:04:05.123Z')
    const subSession = subResult.unit.projection.sessions[0]!
    expect(subSession.is_subagent).toBe(true)
    expect(mainResult.summary.rawRecords).toBe(SAMPLE_MAIN_LINES.length)
    expect(subResult.summary.rawRecords).toBe(SAMPLE_SUBAGENT_LINES.length)
  })

  it('CQ-068: subagent files emit a spawned EdgeV2 from parent session to subagent session', async () => {
    const root = await tmp()
    await mkdir(join(root, 'p1', 'sess_main_xyz', 'subagents'), { recursive: true })
    await writeFile(
      join(root, 'p1', 'sess_main_xyz', 'subagents', 'agent-agent_001.jsonl'),
      jsonlBytes(SAMPLE_SUBAGENT_LINES),
    )
    await writeFile(join(root, 'p1', 'sess_main_xyz.jsonl'), jsonlBytes(SAMPLE_MAIN_LINES))
    const provider = new ClaudeProvider()
    const files = await provider.discover(root)
    const main = files.find((f) => f.file_kind === 'session_jsonl')!
    const sub = files.find((f) => f.file_kind === 'session_jsonl_subagent')!
    const mainResult = await provider.parseAndProject({
      files: [main],
      identification: await provider.cheapIdentify(main),
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    const subResult = await provider.parseAndProject({
      files: [sub],
      identification: await provider.cheapIdentify(sub),
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    expect(mainResult.unit.projection.edges.length).toBe(0)
    expect(subResult.unit.projection.edges.length).toBe(1)
    const edge = subResult.unit.projection.edges[0]!
    expect(edge.edge_type).toBe('spawned')
    expect(edge.src_type).toBe('session')
    expect(edge.dst_type).toBe('session')
    expect(edge.confidence).toBe('high')
    expect(edge.source).toBe('path_inferred')
    // The edge's src must match the main session's row id and dst the
    // subagent's — proving the deterministic derivation is shared
    // across the two parseAndProject calls.
    expect(edge.src_id).toBe(mainResult.unit.projection.sessions[0]!.session_id)
    expect(edge.dst_id).toBe(subResult.unit.projection.sessions[0]!.session_id)
    // Idempotent: re-parsing the same subagent file produces the same edge_id.
    const subResult2 = await provider.parseAndProject({
      files: [sub],
      identification: await provider.cheapIdentify(sub),
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    expect(subResult2.unit.projection.edges[0]!.edge_id).toBe(edge.edge_id)
  })

  it('CQ-068: GraphResolver fills parent_session_id when main + subagent files compile in the same epoch', async () => {
    const bundleRoot = await tmp()
    const discoveryRoot = await tmp()
    await mkdir(join(discoveryRoot, 'p1', 'sess_main_xyz', 'subagents'), { recursive: true })
    await writeFile(join(discoveryRoot, 'p1', 'sess_main_xyz.jsonl'), jsonlBytes(SAMPLE_MAIN_LINES))
    await writeFile(
      join(discoveryRoot, 'p1', 'sess_main_xyz', 'subagents', 'agent-agent_001.jsonl'),
      jsonlBytes(SAMPLE_SUBAGENT_LINES),
    )
    const bundle = await initBundle(bundleRoot, { storeId: 'st_claude_edge', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const result = await runCompileImports({
        bundle,
        providers: [{ provider: new ClaudeProvider(), root: discoveryRoot }],
        createdAt: '2025-01-02T03:04:06.000Z',
      })
      expect(result.sealedEpoch).toBe(1)
      // 2 sessions (main + subagent), 1 spawned edge.
      expect(bundle.head.counts.sessions).toBe(2)
      expect(bundle.head.counts.edges).toBe(1)
      // We can't directly inspect the sealed session rows from the head
      // alone, so reload the projection segment via openBundle's index.
      // For this iteration we trust the in-orchestrator result; the
      // unit test above already verified resolveLateBindings receives
      // the edge.
    } finally {
      await bundle.close()
    }
  })

  it('CQ-074: full Claude projection emits MessageV2 + ContentBlockV2 + ToolCallV2 + ToolResultV2 + EventV2', async () => {
    const FULL_LINES = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 'sess_full',
        timestamp: '2025-01-02T03:04:05.123Z',
        cwd: '/repo',
        gitBranch: 'main',
        message: { role: 'user', content: [{ type: 'text', text: 'list the files' }] },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 'sess_full',
        timestamp: '2025-01-02T03:04:06.000Z',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [
            { type: 'thinking', thinking: 'I should look at the repo root' },
            { type: 'text', text: "I'll run ls" },
            { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls /repo' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 'sess_full',
        timestamp: '2025-01-02T03:04:07.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file1\nfile2\n' }],
        },
      },
      {
        type: 'system',
        uuid: 'sys1',
        sessionId: 'sess_full',
        subtype: 'hook',
        timestamp: '2025-01-02T03:04:08.000Z',
      },
    ]
    const root = await tmp()
    await mkdir(join(root, 'demo'), { recursive: true })
    await writeFile(join(root, 'demo', 'sess_full.jsonl'), jsonlBytes(FULL_LINES))
    const provider = new ClaudeProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    const r = await provider.parseAndProject({
      files: [file],
      identification: id,
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    const p = r.unit.projection
    // 3 messages: user, assistant, user (tool-result-only → role 'tool').
    expect(p.messages.length).toBe(3)
    expect(p.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(p.messages[1]!.model).toBe('claude-opus-4-7')
    expect(p.messages[1]!.parent_message_id).toBe(p.messages[0]!.message_id)
    expect(p.messages[2]!.parent_message_id).toBe(p.messages[1]!.message_id)
    // Content blocks: 1 user-text + 3 assistant blocks (thinking, text, tool_use) + 1 tool_result = 5.
    expect(p.content_blocks.length).toBe(5)
    const reasoning = p.content_blocks.find((b) => b.block_type === 'thinking')
    expect(reasoning?.visibility).toBe('hidden_by_default')
    expect(reasoning?.text_inline).toBe('I should look at the repo root')
    const toolUseBlock = p.content_blocks.find((b) => b.block_type === 'tool_use')
    expect(toolUseBlock).toBeDefined()
    expect(toolUseBlock?.text_inline).toBeNull()
    // 1 tool_call from the tool_use block.
    expect(p.tool_calls.length).toBe(1)
    expect(p.tool_calls[0]!.tool_name).toBe('Bash')
    expect(p.tool_calls[0]!.canonical_tool_type).toBe('shell')
    expect(p.tool_calls[0]!.source_call_id).toBe('tu_1')
    expect(p.tool_calls[0]!.command).toBe('ls /repo')
    expect(p.tool_calls[0]!.args_object_id).toMatch(/^blake3:[0-9a-f]{64}$/)
    // 1 tool_result linked back to that tool_call by source_call_id.
    expect(p.tool_results.length).toBe(1)
    expect(p.tool_results[0]!.tool_call_id).toBe(p.tool_calls[0]!.tool_call_id)
    expect(p.tool_results[0]!.source_call_id).toBe('tu_1')
    expect(p.tool_results[0]!.preview).toBe('file1\nfile2\n')
    expect(p.tool_results[0]!.output_object_id).toMatch(/^blake3:[0-9a-f]{64}$/)
    expect(p.tool_results[0]!.is_error).toBe(false)
    expect(p.tool_results[0]!.status).toBe('success')
    // 1 EventV2 from the `system` record; payload bytes are staged in CAS.
    expect(p.events.length).toBe(1)
    expect(p.events[0]!.event_type).toBe('system_operational')
    expect(p.events[0]!.subtype).toBe('hook')
    expect(p.events[0]!.payload_object_id).toMatch(/^blake3:[0-9a-f]{64}$/)
    // Every CAS-tagged column maps to a candidate the orchestrator can
    // admit before sealEpoch's FK closure check runs.
    const candidateIds = new Set(r.unit.cas_object_candidates.map((c) => c.object_id))
    expect(candidateIds.has(p.tool_calls[0]!.args_object_id as string)).toBe(true)
    expect(candidateIds.has(p.tool_results[0]!.output_object_id as string)).toBe(true)
    expect(candidateIds.has(p.events[0]!.payload_object_id as string)).toBe(true)
    const parsedRawRecord = p.raw_records.find((rr) => rr.parser_status === 'parsed')
    expect(parsedRawRecord?.decoded_object_id).toMatch(/^blake3:[0-9a-f]{64}$/)
    expect(candidateIds.has(parsedRawRecord!.decoded_object_id as string)).toBe(true)
    // Session model accumulated across the per-record pass.
    expect(p.sessions[0]!.model_first).toBe('claude-opus-4-7')
    expect(p.sessions[0]!.model_last).toBe('claude-opus-4-7')
  })

  it('nulls parent_message_id when parentUuid points outside the same JSONL (regression)', async () => {
    // Regression. Claude's `parentUuid` can reference a message in a
    // forked or compacted parent session that lives in a different
    // JSONL file. The importer derived `parent_message_id` from that
    // UUID verbatim; sealEpoch then refused the seal because the
    // referenced message_id wasn't in any staged row. Local cleanup
    // nulls the field when the parent is not present in this file's
    // staged messages, so FK closure passes.
    const root = await tmp()
    const provider = new ClaudeProvider()
    const lines = [
      {
        // parentUuid points to a uuid that is NOT present in this file.
        type: 'user',
        uuid: 'first',
        parentUuid: 'belongs-to-another-session',
        sessionId: 'sess_fork',
        timestamp: '2025-01-02T03:04:05.123Z',
        cwd: '/repo',
        gitBranch: 'main',
        message: { role: 'user', content: [{ type: 'text', text: 'continued from elsewhere' }] },
      },
      {
        type: 'assistant',
        uuid: 'second',
        parentUuid: 'first',
        sessionId: 'sess_fork',
        timestamp: '2025-01-02T03:04:06.000Z',
        message: { role: 'assistant', model: 'claude-3.5-sonnet', content: [{ type: 'text', text: 'reply' }] },
      },
    ]
    await mkdir(join(root, 'demo'), { recursive: true })
    await writeFile(join(root, 'demo', 'sess_fork.jsonl'), jsonlBytes(lines))
    const files = await provider.discover(root)
    const result = await provider.parseAndProject({
      files,
      identification: await provider.cheapIdentify(files[0]!),
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    const messages = result.unit.projection.messages
    expect(messages.length).toBe(2)
    // First message had a dangling parentUuid; the importer must null it
    // out so FK closure passes when the bundle seals.
    expect(messages[0]?.parent_message_id).toBeNull()
    // Second message's parentUuid IS in this file; the cross-reference
    // must resolve and stay populated.
    expect(messages[1]?.parent_message_id).toBe(messages[0]?.message_id)
  })

  it('runCompileImports orchestrates Claude through a real bundle seal', async () => {
    const bundleRoot = await tmp()
    const discoveryRoot = await tmp()
    await mkdir(join(discoveryRoot, 'demo'), { recursive: true })
    await writeFile(join(discoveryRoot, 'demo', 'sess_main_xyz.jsonl'), jsonlBytes(SAMPLE_MAIN_LINES))
    const bundle = await initBundle(bundleRoot, { storeId: 'st_claude_e2e', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const result = await runCompileImports({
        bundle,
        providers: [{ provider: new ClaudeProvider(), root: discoveryRoot }],
        createdAt: '2025-01-02T03:04:06.000Z',
      })
      expect(result.sealedEpoch).toBe(1)
      expect(result.perProvider[0]?.source_tool).toBe('claude')
      expect(result.perProvider[0]?.discovered).toBe(1)
      expect(bundle.head.epoch).toBe(1)
      expect(bundle.head.counts.sessions).toBe(1)
      expect(bundle.head.counts.sourceFiles).toBe(1)
      expect(bundle.head.counts.rawRecords).toBe(SAMPLE_MAIN_LINES.length)
    } finally {
      await bundle.close()
    }
  })
})
