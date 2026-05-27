import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveReadAuthorityOrFailClosed } from '../../src/cli/auth/routing.js'
import { CliUserError } from '../../src/cli/errors.js'

const SERVER_A = 'https://prosa-a.example'
const SERVER_B = 'https://prosa-b.example'

type TestPaths = {
  configPath: string
  promotedStore: string
  otherStore: string
  root: string
}

async function makePaths(): Promise<TestPaths> {
  const root = await mkdtemp(path.join(tmpdir(), 'prosa-routing-unit-'))
  return {
    root,
    configPath: path.join(root, 'config.json'),
    promotedStore: path.join(root, 'promoted-store'),
    otherStore: path.join(root, 'other-store'),
  }
}

async function writeConfig(
  configPath: string,
  opts: {
    activeServer?: string
    promotedStore: string
    token?: string
    tenantId?: string
  },
): Promise<void> {
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        activeServer: opts.activeServer,
        servers: {
          [SERVER_A]: {
            url: SERVER_A,
            token: opts.token,
            promotions: {
              [opts.promotedStore]: {
                batchId: 'batch_a',
                tenantId: opts.tenantId,
                promotedAt: '2026-05-01T00:00:00.000Z',
                receipt: {},
              },
            },
          },
          [SERVER_B]: {
            url: SERVER_B,
            token: 'token-b',
            promotions: {
              [opts.promotedStore]: {
                batchId: 'batch_b',
                tenantId: 'tenant-b',
                promotedAt: '2026-05-02T00:00:00.000Z',
                receipt: {},
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

describe('resolveReadAuthorityOrFailClosed', () => {
  let paths: TestPaths

  beforeEach(async () => {
    paths = await makePaths()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(paths.root, { recursive: true, force: true })
  })

  it('returns local authority for stores without a promotion receipt', async () => {
    await writeConfig(paths.configPath, {
      activeServer: SERVER_A,
      promotedStore: paths.promotedStore,
      token: 'token-a',
      tenantId: 'tenant-a',
    })

    await expect(
      resolveReadAuthorityOrFailClosed({
        commandName: 'sessions',
        storePath: paths.otherStore,
        configPath: paths.configPath,
        remoteSupported: true,
      }),
    ).resolves.toEqual({ kind: 'local', storePath: paths.otherStore })
  })

  it('prefers the active server promotion when multiple servers have the same store', async () => {
    await writeConfig(paths.configPath, {
      activeServer: SERVER_B,
      promotedStore: paths.promotedStore,
      token: 'token-a',
      tenantId: 'tenant-a',
    })

    const authority = await resolveReadAuthorityOrFailClosed({
      commandName: 'sessions',
      storePath: paths.promotedStore,
      configPath: paths.configPath,
      remoteSupported: true,
    })

    expect(authority.kind).toBe('remote')
    if (authority.kind !== 'remote') return
    expect(authority.entry.url).toBe(SERVER_B)
    expect(authority.client.token).toBe('token-b')
    expect(authority.client.tenantId).toBe('tenant-b')
    expect(authority.storePath).toBe(paths.promotedStore)
  })

  it('falls back to a non-active promoted server when the active server has no receipt', async () => {
    await writeFile(
      paths.configPath,
      `${JSON.stringify(
        {
          activeServer: SERVER_A,
          servers: {
            [SERVER_A]: { url: SERVER_A, token: 'token-a' },
            [SERVER_B]: {
              url: SERVER_B,
              token: 'token-b',
              promotions: {
                [paths.promotedStore]: {
                  batchId: 'batch_b',
                  tenantId: 'tenant-b',
                  promotedAt: '2026-05-02T00:00:00.000Z',
                  receipt: {},
                },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )

    const authority = await resolveReadAuthorityOrFailClosed({
      commandName: 'sessions',
      storePath: paths.promotedStore,
      configPath: paths.configPath,
      remoteSupported: true,
    })

    expect(authority.kind).toBe('remote')
    if (authority.kind !== 'remote') return
    expect(authority.entry.url).toBe(SERVER_B)
  })

  it('allows explicit local reads with a stale-data warning', async () => {
    await writeConfig(paths.configPath, {
      activeServer: SERVER_A,
      promotedStore: paths.promotedStore,
      token: 'token-a',
      tenantId: 'tenant-a',
    })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await expect(
      resolveReadAuthorityOrFailClosed({
        commandName: 'sessions',
        storePath: paths.promotedStore,
        forceLocal: true,
        configPath: paths.configPath,
        remoteSupported: true,
      }),
    ).resolves.toEqual({ kind: 'local', storePath: paths.promotedStore })
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Results may be stale.'))
  })

  it('fails closed for unsupported remote-authoritative read surfaces', async () => {
    await writeConfig(paths.configPath, {
      activeServer: SERVER_A,
      promotedStore: paths.promotedStore,
      token: 'token-a',
      tenantId: 'tenant-a',
    })

    await expect(
      resolveReadAuthorityOrFailClosed({
        commandName: 'analytics',
        storePath: paths.promotedStore,
        configPath: paths.configPath,
        remoteSupported: false,
      }),
    ).rejects.toThrow(CliUserError)
    await expect(
      resolveReadAuthorityOrFailClosed({
        commandName: 'analytics',
        storePath: paths.promotedStore,
        configPath: paths.configPath,
        remoteSupported: false,
      }),
    ).rejects.toThrow('Use --local to read the local bundle explicitly')
  })

  it('requires login and tenant metadata before remote reads', async () => {
    await writeConfig(paths.configPath, {
      activeServer: SERVER_A,
      promotedStore: paths.promotedStore,
      tenantId: 'tenant-a',
    })

    await expect(
      resolveReadAuthorityOrFailClosed({
        commandName: 'sessions',
        storePath: paths.promotedStore,
        configPath: paths.configPath,
        remoteSupported: true,
      }),
    ).rejects.toThrow('you are not logged in')

    await writeConfig(paths.configPath, {
      activeServer: SERVER_A,
      promotedStore: paths.promotedStore,
      token: 'token-a',
    })

    await expect(
      resolveReadAuthorityOrFailClosed({
        commandName: 'sessions',
        storePath: paths.promotedStore,
        configPath: paths.configPath,
        remoteSupported: true,
      }),
    ).rejects.toThrow('cannot resolve the promoted store tenant')
  })

  describe('CQ-143: v2 promotions must not bypass the v2 read gate', () => {
    async function writeV2Config(): Promise<void> {
      await writeFile(
        paths.configPath,
        `${JSON.stringify(
          {
            activeServer: SERVER_A,
            servers: {
              [SERVER_A]: {
                url: SERVER_A,
                token: 'token-a',
                promotions: {
                  [paths.promotedStore]: {
                    batchId: 'batch_v2',
                    tenantId: 'tenant-a',
                    promotedAt: '2026-05-20T00:00:00.000Z',
                    // Minimal v2-shape receipt — the routing code
                    // only inspects `payload.receiptVersion`.
                    receipt: {
                      payload: {
                        receiptVersion: 2,
                        receiptId: 'rcp_v2_demo',
                        tenantId: 'tenant-a',
                        storeId: 'store_v2_demo',
                      },
                      signature: { alg: 'Ed25519', keyId: 'k', sig: 'AA' },
                    },
                  },
                },
              },
            },
          },
          null,
          2,
        )}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
    }

    it('fails closed for a v2-promoted store on the legacy session-read path with --local guidance', async () => {
      await writeV2Config()
      const promise = resolveReadAuthorityOrFailClosed({
        commandName: 'prosa sessions',
        storePath: paths.promotedStore,
        configPath: paths.configPath,
        remoteSupported: true,
      })
      await expect(promise).rejects.toBeInstanceOf(CliUserError)
      await expect(promise).rejects.toThrow(/v2-promoted/)
      await expect(promise).rejects.toThrow(/--local/)
    })

    it('allows --local on a v2-promoted store with the stale warning', async () => {
      await writeV2Config()
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      await expect(
        resolveReadAuthorityOrFailClosed({
          commandName: 'prosa sessions',
          storePath: paths.promotedStore,
          forceLocal: true,
          configPath: paths.configPath,
          remoteSupported: true,
        }),
      ).resolves.toEqual({ kind: 'local', storePath: paths.promotedStore })
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Results may be stale.'))
    })

    it('does not affect v1-promoted stores (legacy /trpc/sessions.* still allowed)', async () => {
      await writeConfig(paths.configPath, {
        activeServer: SERVER_A,
        promotedStore: paths.promotedStore,
        token: 'token-a',
        tenantId: 'tenant-a',
      })
      const authority = await resolveReadAuthorityOrFailClosed({
        commandName: 'prosa sessions',
        storePath: paths.promotedStore,
        configPath: paths.configPath,
        remoteSupported: true,
      })
      expect(authority.kind).toBe('remote')
    })
  })
})
