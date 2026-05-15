import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { closeBundle, initBundle } from '@c3-oss/prosa-core'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '../..')
const BIN = path.join(ROOT, 'src/bin/prosa.ts')

async function makeTempRun(): Promise<{
  storePath: string
  cleanup: () => Promise<void>
}> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'prosa-doctor-cli-'))
  const storePath = path.join(rootPath, 'store')
  await mkdir(rootPath, { recursive: true })
  const bundle = await initBundle(storePath)
  closeBundle(bundle)
  return {
    storePath,
    cleanup: () => rm(rootPath, { recursive: true, force: true }),
  }
}

interface ProsaResult {
  stdout: string
  stderr: string
  code: number
}

function runProsa(args: string[]): Promise<ProsaResult> {
  return execFileAsync(
    process.execPath,
    ['--conditions=prosa-dev', '--import', '@swc-node/register/esm-register', BIN, ...args],
    { cwd: ROOT },
  )
    .then(({ stdout, stderr }) => ({ stdout, stderr, code: 0 }))
    .catch((err: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }) => ({
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      code: typeof err.code === 'number' ? err.code : 1,
    }))
}

describe('doctor CLI', () => {
  it('runs successfully on a freshly initialized bundle and exits 0', async () => {
    const t = await makeTempRun()
    try {
      const res = await runProsa(['doctor', '--store', t.storePath])
      expect(res.code).toBe(0)
      expect(res.stdout).toContain('bundle.dir')
      expect(res.stdout).toContain('schema.version')
      expect(res.stdout).toMatch(/pass=\d+ info=\d+ warn=\d+ fail=\d+/)
    } finally {
      await t.cleanup()
    }
  })

  it('emits a well-formed JSON report with summary metadata', async () => {
    const t = await makeTempRun()
    try {
      const res = await runProsa(['doctor', '--store', t.storePath, '--output-format', 'json'])
      expect(res.code).toBe(0)
      const parsed = JSON.parse(res.stdout) as {
        store_path: string
        bundle_opened: boolean
        summary: Record<string, number>
        rows: Array<{ check: string; status: string; message: string }>
      }
      expect(parsed.store_path).toBe(path.resolve(t.storePath))
      expect(parsed.bundle_opened).toBe(true)
      expect(parsed.summary).toMatchObject({ pass: expect.any(Number), fail: expect.any(Number) })
      expect(parsed.rows.length).toBeGreaterThan(5)
      expect(parsed.rows.every((r) => typeof r.check === 'string')).toBe(true)
    } finally {
      await t.cleanup()
    }
  })

  it('--checks filters the emitted check list', async () => {
    const t = await makeTempRun()
    try {
      const res = await runProsa(['doctor', '--store', t.storePath, '--checks', 'sqlite', '--output-format', 'json'])
      expect(res.code).toBe(0)
      const parsed = JSON.parse(res.stdout) as {
        rows: Array<{ check: string }>
      }
      expect(parsed.rows.length).toBeGreaterThan(0)
      for (const row of parsed.rows) {
        expect(row.check.startsWith('sqlite.')).toBe(true)
      }
    } finally {
      await t.cleanup()
    }
  })

  it('exits 2 when the bundle is unopenable (missing manifest)', async () => {
    const t = await makeTempRun()
    try {
      await unlink(path.join(t.storePath, 'manifest.json'))
      const res = await runProsa(['doctor', '--store', t.storePath, '--output-format', 'json'])
      expect(res.code).toBe(2)
      const parsed = JSON.parse(res.stdout) as {
        bundle_opened: boolean
        rows: Array<{ check: string; status: string }>
      }
      expect(parsed.bundle_opened).toBe(false)
      const manifest = parsed.rows.find((r) => r.check === 'bundle.manifest')
      expect(manifest?.status).toBe('fail')
    } finally {
      await t.cleanup()
    }
  })

  it('--strict turns warnings into a non-zero exit', async () => {
    const t = await makeTempRun()
    try {
      // Seed a stuck batch so doctor surfaces a warn.
      const Database = (await import('better-sqlite3')).default
      const db = new Database(path.join(t.storePath, 'prosa.sqlite'))
      db.exec(`
        INSERT INTO import_batches
          (batch_id, parser_version, source_tool, paths, started_at, finished_at, status)
        VALUES
          ('stale-cli', '0.0.0', 'codex', '[]', datetime('now', '-3 hours'), NULL, 'running');
      `)
      db.close()

      const lenient = await runProsa(['doctor', '--store', t.storePath])
      expect(lenient.code).toBe(0)

      const strict = await runProsa(['doctor', '--store', t.storePath, '--strict'])
      expect(strict.code).toBe(1)
      expect(strict.stdout).toContain('import_batches.stuck')
    } finally {
      await t.cleanup()
    }
  })
})
