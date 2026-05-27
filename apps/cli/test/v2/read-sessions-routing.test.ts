// Lane 7 slice 2 — focused routing test for `prosa read sessions`.
//
// Boots no server; instead drives `resolveV2ReadContext` directly so
// we can assert that:
//   - a recorded v2 promotion routes to the remote read client;
//   - the resolver carries the cached authority + audit status into
//     the context the command surface consumes;
//   - the receipt id is taken from the cached authority, not from
//     the stale promotion receipt the CLI persisted on first sync.
//
// End-to-end coverage against a live Fastify instance lives under
// `apps/cli/test/v2/read-sessions-e2e.test.ts` once the harness
// boots a v2 promotion path; this test owns the routing contract.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PromotionReceiptV2 } from '@c3-oss/prosa-types-v2'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type CachedAuthorityV2, writeCachedAuthority } from '../../src/cli/v2/authority/index.js'
import { resolveV2ReadContext } from '../../src/cli/v2/read-context.js'

const TENANT = 'tenant-v2'
const STORE = 'store-v2'

function makeReceipt(receiptId: string): PromotionReceiptV2 {
  return {
    payload: {
      receiptVersion: 2,
      receiptId,
      tenantId: TENANT,
      storeId: STORE,
      bundleRoot: 'b3-bundle-root',
      rawSourceRoot: 'b3-raw-root',
      sealedAt: '2026-05-20T00:00:00.000Z',
      epoch: 1,
      schemaVersion: 'v2',
    } as unknown as PromotionReceiptV2['payload'],
    signature: {
      algorithm: 'ed25519',
      keyId: 'kms-test',
      signedBytes: 'AAA=',
      signature: 'AAA=',
    } as PromotionReceiptV2['signature'],
  }
}

describe('resolveV2ReadContext', () => {
  let root: string
  let configPath: string
  let storePath: string
  let authorityDir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'prosa-read-routing-'))
    configPath = path.join(root, 'config.json')
    storePath = path.join(root, '.prosa')
    authorityDir = path.join(root, 'authority')
    await mkdir(storePath, { recursive: true })
  })

  afterEach(async () => {
    await import('node:fs/promises').then((m) => m.rm(root, { recursive: true, force: true }))
  })

  it('routes to local when no promotion is recorded', async () => {
    await writeFile(configPath, JSON.stringify({ servers: {} }), { encoding: 'utf8', mode: 0o600 })
    const ctx = await resolveV2ReadContext({
      commandName: 'prosa read sessions',
      storePath,
      configPath,
      authorityDir,
    })
    expect(ctx.kind).toBe('local')
  })

  it('routes to remote when a v2 promotion is recorded for the store', async () => {
    const receipt = makeReceipt('r-fresh')
    const config = {
      activeServer: 'http://api.test',
      servers: {
        'http://api.test': {
          url: 'http://api.test',
          token: 'tok',
          user: { id: 'u1', email: 'u@example.com', name: 'U' },
          promotions: {
            [path.resolve(storePath)]: {
              batchId: 'b1',
              tenantId: TENANT,
              promotedAt: '2026-05-20T00:00:00.000Z',
              receipt,
            },
          },
        },
      },
    }
    await writeFile(configPath, JSON.stringify(config), { encoding: 'utf8', mode: 0o600 })

    const cached: CachedAuthorityV2 = {
      tenantId: TENANT,
      storeId: STORE,
      receiptId: 'r-fresh',
      receipt,
      serverUrl: 'http://api.test',
      checkedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      auditStatus: 'audit_pending',
    }
    await writeCachedAuthority(authorityDir, cached)

    const ctx = await resolveV2ReadContext({
      commandName: 'prosa read sessions',
      storePath,
      configPath,
      authorityDir,
    })
    expect(ctx.kind).toBe('remote')
    if (ctx.kind !== 'remote') return
    expect(ctx.storeId).toBe(STORE)
    expect(ctx.authority.receiptId).toBe('r-fresh')
    expect(ctx.authority.auditStatus).toBe('audit_pending')
    expect(ctx.client.tenantId).toBe(TENANT)
    expect(ctx.client.token).toBe('tok')
  })

  it('--authority local forces local even when a v2 promotion is recorded', async () => {
    const receipt = makeReceipt('r-fresh')
    await writeFile(
      configPath,
      JSON.stringify({
        activeServer: 'http://api.test',
        servers: {
          'http://api.test': {
            url: 'http://api.test',
            token: 'tok',
            promotions: {
              [path.resolve(storePath)]: {
                batchId: 'b1',
                tenantId: TENANT,
                promotedAt: '2026-05-20T00:00:00.000Z',
                receipt,
              },
            },
          },
        },
      }),
      { encoding: 'utf8', mode: 0o600 },
    )
    const ctx = await resolveV2ReadContext({
      commandName: 'prosa read sessions',
      storePath,
      configPath,
      authorityDir,
      authorityMode: 'local',
    })
    expect(ctx.kind).toBe('local')
  })

  it('--authority remote fails closed when no v2 promotion is recorded', async () => {
    await writeFile(configPath, JSON.stringify({ servers: {} }), { encoding: 'utf8', mode: 0o600 })
    await expect(
      resolveV2ReadContext({
        commandName: 'prosa read sessions',
        storePath,
        configPath,
        authorityDir,
        authorityMode: 'remote',
      }),
    ).rejects.toThrow(/--authority remote/)
  })

  it('treats v1-shaped promotion receipts as un-promoted (routes to local)', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        activeServer: 'http://api.test',
        servers: {
          'http://api.test': {
            url: 'http://api.test',
            token: 'tok',
            promotions: {
              [path.resolve(storePath)]: {
                batchId: 'b1',
                tenantId: TENANT,
                promotedAt: '2026-05-20T00:00:00.000Z',
                receipt: { sessionCount: 1, objectCount: 0, searchDocCount: 1 },
              },
            },
          },
        },
      }),
      { encoding: 'utf8', mode: 0o600 },
    )
    const ctx = await resolveV2ReadContext({
      commandName: 'prosa read sessions',
      storePath,
      configPath,
      authorityDir,
    })
    expect(ctx.kind).toBe('local')
  })
})
