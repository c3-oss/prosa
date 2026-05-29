// Integration tests for `prosa v2 compile <provider>` and
// `prosa v2 compile-all` — the Lane 2 CLI surface that wraps
// `runCompileImports` against the five real providers.
//
// We spawn the CLI as a subprocess to exercise the same code path
// real users hit. Each test creates a synthetic discovery root
// containing the smallest possible per-provider fixture, runs the
// CLI against a fresh bundle, parses the JSON summary, and reopens
// the bundle to confirm head.json reflects the seal.

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openBundle } from '@c3-oss/prosa-bundle-v2'
import { describe, expect, it } from 'vitest'

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'prosa-cli-v2-'))
}

const CLI_ENTRY = join(__dirname, '..', '..', 'src', 'bin', 'prosa.ts')

function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    'node',
    ['--conditions=prosa-dev', '--import', '@swc-node/register/esm-register', CLI_ENTRY, ...args],
    { encoding: 'utf8', timeout: 60_000 },
  )
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

const CODEX_LINE = {
  type: 'session_meta',
  timestamp: '2025-01-02T03:04:05.123Z',
  payload: { id: 'sess_codex_cli', cwd: '/repo' },
}
const CLAUDE_LINE = {
  type: 'user',
  uuid: 'u-1',
  sessionId: 'sess_claude_cli',
  timestamp: '2025-01-02T03:04:05.123Z',
  message: { role: 'user', content: 'hi' },
}
const GEMINI_SESSION = {
  sessionId: 'sess_gemini_cli',
  startTime: '2025-01-02T03:04:05.123Z',
  messages: [{ type: 'user', content: 'hello' }],
}
const HERMES_LINE = {
  session_id: 'sess_hermes_cli',
  timestamp: '2025-01-02T03:04:05.123Z',
  content: 'hi',
}

describe('prosa v2 compile / v2 compile-all CLI', () => {
  it('CQ-072: `v2 compile --help` prints the usage banner and exits 0', async () => {
    const r = runCli(['v2', 'compile', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Compile a single provider into a bundle v2 store')
    expect(r.stdout).toContain('<provider>')
    expect(r.stdout).toContain('--store')
  })

  it('CQ-072: `v2 compile-all --help` prints the usage banner and exits 0', async () => {
    const r = runCli(['v2', 'compile-all', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Compile every supported provider')
    expect(r.stdout).toContain('--codex-root')
    expect(r.stdout).toContain('--claude-root')
    expect(r.stdout).toContain('--cursor-root')
    expect(r.stdout).toContain('--gemini-root')
    expect(r.stdout).toContain('--hermes-root')
  })

  it('v2 compile codex against a synthetic Codex rollout seals one epoch', async () => {
    const storeRoot = await tmp()
    const codexRoot = await tmp()
    await mkdir(join(codexRoot, '2025', '01', '02'), { recursive: true })
    await writeFile(join(codexRoot, '2025', '01', '02', 'rollout-cli.jsonl'), `${JSON.stringify(CODEX_LINE)}\n`)
    const r = runCli(['v2', 'compile', 'codex', '--store', storeRoot, '--root', codexRoot])
    expect(r.status).toBe(0)
    const summary = JSON.parse(r.stdout) as {
      sealedEpoch: number
      perProvider: Array<{ source_tool: string; discovered: number; won: number }>
    }
    expect(summary.sealedEpoch).toBe(1)
    expect(summary.perProvider[0]?.source_tool).toBe('codex')
    expect(summary.perProvider[0]?.discovered).toBe(1)
    expect(summary.perProvider[0]?.won).toBe(1)
    const bundle = await openBundle(storeRoot)
    try {
      expect(bundle.head.epoch).toBe(1)
      expect(bundle.head.counts.sessions).toBe(1)
    } finally {
      await bundle.close()
    }
  })

  it('v2 compile rejects unknown provider names with exit code 2', async () => {
    const storeRoot = await tmp()
    const r = runCli(['v2', 'compile', 'bogus-provider', '--store', storeRoot])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('unknown provider')
  })

  it('v2 compile-all runs every provider against per-provider roots and seals one epoch', async () => {
    const storeRoot = await tmp()
    const codexRoot = await tmp()
    const claudeRoot = await tmp()
    const cursorRoot = await tmp()
    const geminiRoot = await tmp()
    const hermesRoot = await tmp()

    await mkdir(join(codexRoot, '2025', '01', '02'), { recursive: true })
    await writeFile(join(codexRoot, '2025', '01', '02', 'rollout-cli.jsonl'), `${JSON.stringify(CODEX_LINE)}\n`)
    await mkdir(join(claudeRoot, 'demo'), { recursive: true })
    await writeFile(join(claudeRoot, 'demo', 'sess_claude_cli.jsonl'), `${JSON.stringify(CLAUDE_LINE)}\n`)
    await mkdir(join(cursorRoot, 'ws-a', 'agent-a'), { recursive: true })
    // Fake SQLite-shaped bytes (the minimal Cursor provider treats
    // store.db as opaque).
    const cursorBytes = new Uint8Array([
      0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00, 0x66, 0x61, 0x6b,
      0x65,
    ])
    await writeFile(join(cursorRoot, 'ws-a', 'agent-a', 'store.db'), cursorBytes)
    await mkdir(join(geminiRoot, 'proj-x', 'chats'), { recursive: true })
    await writeFile(join(geminiRoot, 'proj-x', 'chats', 'session-001.json'), JSON.stringify(GEMINI_SESSION))
    await writeFile(join(hermesRoot, 'sess_hermes_cli.jsonl'), `${JSON.stringify(HERMES_LINE)}\n`)

    const r = runCli([
      'v2',
      'compile-all',
      '--store',
      storeRoot,
      '--codex-root',
      codexRoot,
      '--claude-root',
      claudeRoot,
      '--cursor-root',
      cursorRoot,
      '--gemini-root',
      geminiRoot,
      '--hermes-root',
      hermesRoot,
    ])
    if (r.status !== 0) {
      throw new Error(`v2 compile-all failed (status=${r.status}): ${r.stderr}\nstdout: ${r.stdout}`)
    }
    const summary = JSON.parse(r.stdout) as {
      sealedEpoch: number
      perProvider: Array<{ source_tool: string }>
    }
    expect(summary.sealedEpoch).toBe(1)
    const tools = summary.perProvider.map((p) => p.source_tool).sort()
    expect(tools).toEqual(['claude', 'codex', 'cursor', 'gemini', 'hermes'])
    const bundle = await openBundle(storeRoot)
    try {
      expect(bundle.head.epoch).toBe(1)
      // 5 sessions (one per provider).
      expect(bundle.head.counts.sessions).toBe(5)
    } finally {
      await bundle.close()
    }
  }, 30_000)
})
