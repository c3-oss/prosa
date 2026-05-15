import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProsaApiClient } from '../../src/cli/auth/client.js'
import { saveCliConfig } from '../../src/cli/auth/config.js'
import { authCommand } from '../../src/cli/commands/auth.js'

const SERVER = 'https://prosa.example'

type Capture = {
  lines: string[]
  restore: () => void
}

function captureStdout(): Capture {
  const original = process.stdout.write.bind(process.stdout)
  const lines: string[] = []
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    lines.push(...text.split('\n').filter(Boolean))
    return true
  }) as typeof process.stdout.write
  return {
    lines,
    restore: () => {
      process.stdout.write = original
    },
  }
}

async function runAuth(args: string[], configPath: string): Promise<void> {
  const cmd = authCommand()
  await cmd.parseAsync(['node', 'auth', '--config', configPath, ...args])
}

describe('authCommand', () => {
  let root: string
  let configPath: string
  let stdout: Capture

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'prosa-auth-command-'))
    configPath = path.join(root, 'config.json')
    stdout = captureStdout()
  })

  afterEach(async () => {
    stdout.restore()
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it('prints logged-out status as JSON without creating config', async () => {
    await runAuth(['status', '--json'], configPath)

    expect(JSON.parse(stdout.lines.join('\n'))).toEqual({ loggedIn: false })
  })

  it('signs up, saves the active tenant, and prints JSON output', async () => {
    vi.spyOn(ProsaApiClient.prototype, 'signupWithTenant').mockResolvedValue({
      token: 'token-signup',
      user: { id: 'u1', email: 'a@example.com', name: 'Alice' },
      tenant: { id: 't1', name: 'Team', slug: 'team' },
    })
    vi.spyOn(ProsaApiClient.prototype, 'me').mockResolvedValue({
      user: { id: 'u1', email: 'a@example.com', name: 'Alice' },
      session: { expiresAt: '2026-05-16T00:00:00.000Z' },
      tenantId: 't1',
      memberRole: 'admin',
    })

    await runAuth(
      [
        'signup',
        '--server',
        SERVER,
        '--email',
        'a@example.com',
        '--password',
        'password123',
        '--name',
        'Alice',
        '--tenant',
        'Team',
        '--tenant-slug',
        'team',
        '--json',
      ],
      configPath,
    )

    expect(JSON.parse(stdout.lines.join('\n'))).toMatchObject({
      ok: true,
      server: SERVER,
      tenant: { id: 't1', name: 'Team' },
    })
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      activeServer: string
      servers: Record<string, { activeTenant?: { id: string }; tokenExpiresAt?: string }>
    }
    expect(config.activeServer).toBe(SERVER)
    expect(config.servers[SERVER]?.activeTenant?.id).toBe('t1')
    expect(config.servers[SERVER]?.tokenExpiresAt).toBe('2026-05-16T00:00:00.000Z')
  })

  it('logs in, lists tenants, and sets an active tenant by slug', async () => {
    vi.spyOn(ProsaApiClient.prototype, 'signInEmail').mockResolvedValue({
      token: 'token-login',
      user: { id: 'u1', email: 'a@example.com', name: 'Alice' },
    })
    vi.spyOn(ProsaApiClient.prototype, 'me').mockRejectedValue(new Error('offline'))
    vi.spyOn(ProsaApiClient.prototype, 'listTenants').mockResolvedValue([
      { id: 't1', name: 'Team One', slug: 'one' },
      { id: 't2', name: 'Team Two', slug: 'two' },
    ])
    const setActiveTenant = vi.spyOn(ProsaApiClient.prototype, 'setActiveTenant').mockResolvedValue({ tenantId: 't2' })

    await runAuth(['login', '--server', SERVER, '--email', 'a@example.com', '--password', 'password123'], configPath)
    await runAuth(['tenants'], configPath)
    await runAuth(['use', 'two'], configPath)

    expect(stdout.lines.join('\n')).toContain('logged in as a@example.com; 2 tenant(s) available (active: Team One)')
    expect(stdout.lines.join('\n')).toContain('t1\tTeam One\tone')
    expect(stdout.lines.join('\n')).toContain('active tenant: Team Two (t2)')
    expect(setActiveTenant).toHaveBeenCalledWith('t2')
  })

  it('reports full status and handles local logout when remote revocation fails', async () => {
    await saveCliConfig(
      {
        activeServer: SERVER,
        servers: {
          [SERVER]: {
            url: SERVER,
            token: 'token',
            user: { id: 'u1', email: 'a@example.com', name: 'Alice' },
            activeTenant: { id: 't1', name: 'Team', slug: 'team' },
            tokenExpiresAt: '2026-05-16T00:00:00.000Z',
            device: { id: 'd1', name: 'laptop' },
            promotions: {
              '/tmp/.prosa': {
                batchId: 'b1',
                tenantId: 't1',
                promotedAt: '2026-05-15T00:00:00.000Z',
                receipt: {},
              },
            },
          },
        },
      },
      configPath,
    )
    vi.spyOn(ProsaApiClient.prototype, 'signOut').mockRejectedValue(new Error('network down'))

    await runAuth(['status'], configPath)
    await runAuth(['logout'], configPath)

    const text = stdout.lines.join('\n')
    expect(text).toContain('server: https://prosa.example')
    expect(text).toContain('promoted: 1')
    expect(text).toContain('logged out locally; remote session revocation failed: network down')
  })

  it('clears all local credentials without calling the server', async () => {
    await saveCliConfig({ activeServer: SERVER, servers: { [SERVER]: { url: SERVER, token: 'token' } } }, configPath)
    const signOut = vi.spyOn(ProsaApiClient.prototype, 'signOut')

    await runAuth(['logout', '--all'], configPath)

    expect(signOut).not.toHaveBeenCalled()
    await expect(readFile(configPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(stdout.lines).toContain('cleared all local prosa CLI credentials')
  })
})
