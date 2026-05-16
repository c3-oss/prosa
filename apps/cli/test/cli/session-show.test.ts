import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { compileCodex, listSessions } from '@c3-oss/prosa-core'
import { describe, expect, it } from 'vitest'
import { createTempBundle } from '../helpers/tmp-bundle.js'

const execFileAsync = promisify(execFile)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '../..')
const BIN = path.join(ROOT, 'src/bin/prosa.ts')
const CODEX_FIXTURES = path.join(ROOT, '../../packages/prosa-core/test/fixtures/codex')

/**
 * Spawn `prosa session show` against an isolated bundle compiled from the
 * codex fixture. Substring assertions stay robust against cosmetic format
 * tweaks while still catching role/header/tool-call regressions.
 */
async function runShow(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--conditions=prosa-dev', '--import', '@swc-node/register/esm-register', BIN, 'session', 'show', ...args],
    { cwd: ROOT, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } },
  )
  return stdout
}

describe('session show CLI', () => {
  it('renders the transcript in plain text with role headers and message body', async () => {
    const t = await createTempBundle()
    try {
      await compileCodex(t.bundle, CODEX_FIXTURES)
      const session = listSessions(t.bundle, { sourceTool: 'codex' }).find((s) => s.is_subagent === 0)
      expect(session, 'expected at least one non-subagent codex session in the fixture').toBeDefined()

      const stdout = await runShow(
        [session!.session_id, '--store', t.path, '--format', 'text', '--no-color', '--local'],
        t.path,
      )

      // Header surfaces source + session metadata.
      expect(stdout).toContain('source:')
      expect(stdout).toContain(`session_id: ${session!.session_id}`)
      // Both user and assistant turns are tagged with role headers.
      expect(stdout).toMatch(/\[user\]/)
      expect(stdout).toMatch(/\[assistant\]/)
      // The fixture's first user prompt and assistant reply text appear.
      expect(stdout).toContain('Run terraform plan')
      expect(stdout).toContain('Running terraform plan')
      // The fixture's tool call is summarized as a labeled section.
      expect(stdout).toMatch(/tool:\s+shell/)
    } finally {
      await t.cleanup()
    }
  })

  it('renders the transcript as Markdown (assistant headers + tool sections)', async () => {
    const t = await createTempBundle()
    try {
      await compileCodex(t.bundle, CODEX_FIXTURES)
      const session = listSessions(t.bundle, { sourceTool: 'codex' }).find((s) => s.is_subagent === 0)!

      const stdout = await runShow([session.session_id, '--store', t.path, '--format', 'markdown', '--local'], t.path)

      // Markdown export uses heading prefixes for roles and includes tool blocks.
      expect(stdout).toMatch(/^#\s/m)
      expect(stdout).toContain('Run terraform plan')
      expect(stdout).toMatch(/tool:\s+shell/)
    } finally {
      await t.cleanup()
    }
  })

  it('renders the transcript as valid JSON with top-level transcript keys', async () => {
    const t = await createTempBundle()
    try {
      await compileCodex(t.bundle, CODEX_FIXTURES)
      const session = listSessions(t.bundle, { sourceTool: 'codex' }).find((s) => s.is_subagent === 0)!

      const stdout = await runShow([session.session_id, '--store', t.path, '--format', 'json', '--local'], t.path)

      const parsed = JSON.parse(stdout) as Record<string, unknown>
      expect(parsed).toHaveProperty('session')
      expect(parsed).toHaveProperty('turns')
      expect(parsed).toHaveProperty('unattachedToolCalls')
      expect(Array.isArray(parsed.turns)).toBe(true)
      expect((parsed.turns as unknown[]).length).toBeGreaterThan(0)
      const firstTurn = (parsed.turns as Array<Record<string, unknown>>)[0]!
      expect(firstTurn).toHaveProperty('role')
      expect(firstTurn).toHaveProperty('blocks')
      expect(firstTurn).toHaveProperty('toolCalls')
    } finally {
      await t.cleanup()
    }
  })

  it('exits with an error message when the session is not found', async () => {
    const t = await createTempBundle()
    try {
      await expect(
        runShow(['sess:does-not-exist', '--store', t.path, '--format', 'text', '--no-color', '--local'], t.path),
      ).rejects.toMatchObject({
        // CliUserError prints to stderr and exits non-zero; the message
        // surfaces via the rejection's stderr/message fields.
        message: expect.stringContaining('session not found'),
      })
    } finally {
      await t.cleanup()
    }
  })
})
