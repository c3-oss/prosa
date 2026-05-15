import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCliConfig, saveCliConfig } from '../../src/cli/auth/config.js'
import { authCommand } from '../../src/cli/commands/auth.js'

async function capturedAuthRun(args: string[]): Promise<{ stdout: string }> {
  const original = process.stdout.write.bind(process.stdout)
  const captured: string[] = []
  process.stdout.write = ((chunk: unknown) => {
    captured.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    await authCommand().parseAsync(args, { from: 'user' })
  } finally {
    process.stdout.write = original
  }
  return { stdout: captured.join('') }
}

describe('auth token lifecycle', () => {
  let tmp: string
  let configPath: string

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'prosa-auth-lifecycle-'))
    configPath = path.join(tmp, 'config.json')
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(tmp, { recursive: true, force: true })
  })

  it('logout clears local credentials and reports remote revocation failure', async () => {
    await saveCliConfig(
      {
        activeServer: 'http://server.test',
        servers: {
          'http://server.test': {
            url: 'http://server.test',
            token: 'tok',
            tokenExpiresAt: '2030-01-01T00:00:00.000Z',
          },
        },
      },
      configPath,
    )
    vi.stubGlobal(
      'fetch',
      async () => new Response('unavailable', { status: 503, headers: { 'content-type': 'text/plain' } }),
    )

    const out = await capturedAuthRun(['--config', configPath, 'logout'])
    expect(out.stdout).toContain('logged out locally; remote session revocation failed')
    const reloaded = await loadCliConfig(configPath)
    expect(reloaded.activeServer).toBeUndefined()
    expect(reloaded.servers).toEqual({})
  })

  it('repairs insecure config permissions before reading stored tokens', async () => {
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(
      configPath,
      `${JSON.stringify({
        activeServer: 'http://server.test',
        servers: { 'http://server.test': { url: 'http://server.test', token: 'tok' } },
      })}\n`,
      { mode: 0o644 },
    )
    await chmod(configPath, 0o644)

    const config = await loadCliConfig(configPath)
    expect(config.servers['http://server.test']?.token).toBe('tok')
    const stats = await stat(configPath)
    expect(stats.mode & 0o777).toBe(0o600)
  })
})
