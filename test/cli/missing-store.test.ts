import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '../..')
const BIN = path.join(ROOT, 'src/bin/prosa.ts')

describe('missing store CLI guidance', () => {
  it('tells users to initialize the default store for compile-all', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'prosa-missing-store-'))
    const homePath = path.join(rootPath, 'home')
    await mkdir(homePath, { recursive: true })
    try {
      const error = await runProsa(['compile-all'], envWithHomeOnly(homePath)).catch((err: unknown) => err)

      expect(error).toMatchObject({
        code: 1,
        stderr: expect.stringContaining(`No default prosa store found at ${path.join(homePath, '.prosa')}.`),
      })
      expect(error.stderr).toContain('Run `prosa init` to create it.')
      expect(error.stderr).not.toContain('CliUserError')
      expect(error.stderr).not.toContain('BundleNotInitializedError')
      expect(error.stderr).not.toContain('openBundle')
    } finally {
      await rm(rootPath, { recursive: true, force: true })
    }
  })

  it('tells users how to initialize an explicit store for read commands', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'prosa-missing-store-'))
    const storePath = path.join(rootPath, 'store')
    try {
      const error = await runProsa(['sessions', '--store', storePath]).catch((err: unknown) => err)

      expect(error).toMatchObject({
        code: 1,
        stderr: expect.stringContaining(`No prosa store found at ${storePath}.`),
      })
      expect(error.stderr).toContain(`Run \`prosa init --store ${storePath}\` to create it.`)
      expect(error.stderr).not.toContain('CliUserError')
      expect(error.stderr).not.toContain('BundleNotInitializedError')
      expect(error.stderr).not.toContain('openBundle')
    } finally {
      await rm(rootPath, { recursive: true, force: true })
    }
  })

  it('uses the same guidance for export commands that open the bundle through services', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'prosa-missing-store-'))
    const storePath = path.join(rootPath, 'store')
    try {
      const error = await runProsa(['export', 'parquet', '--store', storePath]).catch((err: unknown) => err)

      expect(error).toMatchObject({
        code: 1,
        stderr: expect.stringContaining(`No prosa store found at ${storePath}.`),
      })
      expect(error.stderr).toContain(`Run \`prosa init --store ${storePath}\` to create it.`)
      expect(error.stderr).not.toContain('CliUserError')
      expect(error.stderr).not.toContain('BundleNotInitializedError')
      expect(error.stderr).not.toContain('openBundle')
    } finally {
      await rm(rootPath, { recursive: true, force: true })
    }
  })
})

function runProsa(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ['--import', '@swc-node/register/esm-register', BIN, ...args], {
    cwd: ROOT,
    env,
  })
}

function envWithHomeOnly(homePath: string): NodeJS.ProcessEnv {
  const env = { ...process.env, HOME: homePath }
  env.PROSA_STORE = undefined
  return env
}
