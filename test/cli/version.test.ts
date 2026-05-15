import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { PROSA_PARSER_VERSION } from '../../src/core/version.js'

const execFileAsync = promisify(execFile)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '../..')
const BIN = path.join(ROOT, 'src/bin/prosa.ts')

describe('version reporting', () => {
  it('uses the package version for parser metadata and the CLI --version output', async () => {
    const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as {
      version: string
    }

    expect(PROSA_PARSER_VERSION).toBe(packageJson.version)

    const { stdout } = await execFileAsync(
      process.execPath,
      ['--import', '@swc-node/register/esm-register', BIN, '--version'],
      { cwd: ROOT },
    )
    expect(stdout.trim()).toBe(packageJson.version)
  })
})
