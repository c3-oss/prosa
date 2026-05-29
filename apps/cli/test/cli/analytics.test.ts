import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { compileCodex } from '@c3-oss/prosa-core'
import { describe, expect, it } from 'vitest'
import { createTempBundle } from '../helpers/tmp-bundle.js'

const execFileAsync = promisify(execFile)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '../..')
const BIN = path.join(ROOT, 'src/bin/prosa.ts')
const CODEX_FIXTURES = path.join(ROOT, '../../packages/prosa-core/test/fixtures/codex')

describe('analytics CLI', () => {
  it('refreshes Parquet and prints analytics reports', async () => {
    const t = await createTempBundle()
    try {
      await compileCodex(t.bundle, CODEX_FIXTURES)

      const sessions = await execProsa([
        'v1',
        'analytics',
        'sessions',
        '--store',
        t.path,
        '--refresh',
        '--output-format',
        'json',
      ])
      const sessionsPayload = JSON.parse(sessions.stdout) as {
        report: string
        rows: Array<{ source_tool: string; session_id: string }>
      }
      expect(sessionsPayload.report).toBe('sessions')
      expect(sessionsPayload.rows).toHaveLength(2)
      expect(sessionsPayload.rows.every((row) => row.source_tool === 'codex')).toBe(true)

      const tools = await execProsa([
        'v1',
        'analytics',
        'tools',
        '--store',
        t.path,
        '--source',
        'codex',
        '--output-format',
        'json',
      ])
      const toolsPayload = JSON.parse(tools.stdout) as {
        report: string
        rows: Array<{ source_tool: string; call_count: string }>
      }
      expect(toolsPayload.report).toBe('tools')
      expect(toolsPayload.rows).toHaveLength(1)
      expect(toolsPayload.rows[0]?.source_tool).toBe('codex')
      expect(toolsPayload.rows[0]?.call_count).toBe('2')

      for (const report of ['errors', 'models', 'projects'] as const) {
        const { stdout } = await execProsa(['v1', 'analytics', report, '--store', t.path, '--output-format', 'json'])
        const payload = JSON.parse(stdout) as { report: string; rows: unknown[] }
        expect(payload.report).toBe(report)
        expect(Array.isArray(payload.rows)).toBe(true)
      }
    } finally {
      await t.cleanup()
    }
  })

  it('renders only the default analytics sessions columns in table output', async () => {
    const t = await createTempBundle()
    try {
      await compileCodex(t.bundle, CODEX_FIXTURES)

      const def = await execProsa(['v1', 'analytics', 'sessions', '--store', t.path, '--refresh'])
      // The default header omits source_file_path / session_id / source_session_id.
      const header = def.stdout.split('\n')[0] ?? ''
      expect(header).toContain('start_ts')
      expect(header).toContain('project_name')
      expect(header).toContain('title')
      expect(header).not.toContain('source_file_path')
      expect(header).not.toContain('source_session_id')
      expect(header).not.toContain('session_id ') // bare session_id column

      // --columns all brings back the full set.
      const wide = await execProsa(['v1', 'analytics', 'sessions', '--store', t.path, '--columns', 'all'])
      const wideHeader = wide.stdout.split('\n')[0] ?? ''
      expect(wideHeader).toContain('source_file_path')
      expect(wideHeader).toContain('source_session_id')
    } finally {
      await t.cleanup()
    }
  })

  it('rejects unknown --columns entries with a helpful message', async () => {
    const t = await createTempBundle()
    try {
      await compileCodex(t.bundle, CODEX_FIXTURES)

      const error = await execProsa([
        'v1',
        'analytics',
        'sessions',
        '--store',
        t.path,
        '--refresh',
        '--columns',
        'not_a_column',
      ]).catch((err: { stderr?: string; stdout?: string }) => err)

      const stderr = (error as { stderr?: string }).stderr ?? ''
      expect(stderr).toMatch(/unknown column: not_a_column/)
    } finally {
      await t.cleanup()
    }
  })
})

function execProsa(args: string[]) {
  return execFileAsync(
    process.execPath,
    ['--conditions=prosa-dev', '--import', '@swc-node/register/esm-register', BIN, ...args],
    { cwd: ROOT },
  )
}
