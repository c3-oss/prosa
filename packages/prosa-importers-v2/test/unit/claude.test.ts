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
