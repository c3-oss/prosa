import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { closeBundle, getSearchIndexStatus, initBundle, openBundle, searchFullText } from '@c3-oss/prosa-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '../..')
const BIN = path.join(ROOT, 'src/bin/prosa.ts')
const CODEX_FIXTURES = path.join(ROOT, '../../packages/prosa-core/test/fixtures/codex')

describe('index CLI', () => {
  let storePath: string

  beforeEach(async () => {
    storePath = await mkdtemp(path.join(os.tmpdir(), 'prosa-index-cli-'))
    const bundle = await initBundle(storePath)
    closeBundle(bundle)
  })

  afterEach(async () => {
    await rm(storePath, { recursive: true, force: true })
  })

  it('compile auto-rebuilds the FTS5 index so search works immediately', async () => {
    await runProsa(['compile', 'codex', '--sessions-path', CODEX_FIXTURES, '--store', storePath])

    const bundle = await openBundle(storePath)
    try {
      const status = getSearchIndexStatus(bundle, 'fts5')
      expect(status?.status).toBe('ready')
      expect(searchFullText(bundle, { query: 'terraform' }).length).toBeGreaterThan(0)
    } finally {
      closeBundle(bundle)
    }
  })

  it('index fts5 standalone command rebuilds from search_docs', async () => {
    await runProsa(['compile', 'codex', '--sessions-path', CODEX_FIXTURES, '--store', storePath])

    const { stdout } = await runProsa(['index', 'fts5', '--store', storePath])
    expect(stdout).toContain('fts5 index: ready')

    const bundle = await openBundle(storePath)
    try {
      expect(searchFullText(bundle, { query: 'terraform' }).length).toBeGreaterThan(0)
    } finally {
      closeBundle(bundle)
    }
  })
})

function runProsa(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    ['--conditions=prosa-dev', '--import', '@swc-node/register/esm-register', BIN, ...args],
    {
      cwd: ROOT,
    },
  )
}
