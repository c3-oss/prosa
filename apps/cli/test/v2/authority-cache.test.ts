// Lane 7 slice 1 — focused test for the v2 authority cache + resolver.
//
// Pins the L12 contract:
//   - within the 60 s TTL, `resolveAuthority` does not hit the network;
//   - outside the TTL, it refreshes via GET /v2/stores/:storeId/authority;
//   - `--refresh` forces a refresh even when the cache is fresh;
//   - `--offline` uses the cached entry and fails closed when none exists;
//   - the cache file lands at `<configDir>/authority/<storeId>.json`.

import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PromotionReceiptV2 } from '@c3-oss/prosa-types-v2'
import { describe, expect, it } from 'vitest'
import {
  AUTHORITY_TTL_MS,
  type AuthorityRefreshWire,
  AuthorityResolveError,
  type CachedAuthorityV2,
  getCachedAuthority,
  refreshAuthorityNow,
  resolveAuthority,
  writeCachedAuthority,
} from '../../src/cli/v2/authority/index.js'

const STORE_ID = 'store-abc'
const TENANT_ID = 'tenant-xyz'
const SERVER_URL = 'http://test.invalid'

function makeReceipt(receiptId: string): PromotionReceiptV2 {
  return {
    payload: {
      receiptId,
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      bundleRoot: 'b3-bundle-root',
      rawSourceRoot: 'b3-raw-root',
      sealedAt: '2026-05-20T00:00:00.000Z',
      epoch: 1,
      schemaVersion: 'v2',
    } as PromotionReceiptV2['payload'],
    signature: {
      algorithm: 'ed25519',
      keyId: 'kms-test',
      signedBytes: 'AAA=',
      signature: 'AAA=',
    } as PromotionReceiptV2['signature'],
  }
}

async function tmpConfigDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'prosa-authority-cache-'))
}

function mockFetchOnce(response: AuthorityRefreshWire | { status: number; body: unknown }): {
  fetch: typeof fetch
  calls: { url: string; init: RequestInit }[]
} {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    if ('status' in response && 'body' in response) {
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      }) as unknown as Response
    }
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }) as unknown as Response
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

describe('v2 authority cache', () => {
  it('skips the network within the 60 s TTL', async () => {
    const dir = await tmpConfigDir()
    const cached: CachedAuthorityV2 = {
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      receiptId: 'r1',
      receipt: makeReceipt('r1'),
      serverUrl: SERVER_URL,
      checkedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      auditStatus: 'ok',
    }
    await writeCachedAuthority(dir, cached)

    const { fetch: stub, calls } = mockFetchOnce({ status: 500, body: { code: 'BOOM' } })
    const resolved = await resolveAuthority({
      configDir: dir,
      serverUrl: SERVER_URL,
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      token: 'token',
      fetch: stub,
    })

    expect(resolved.receiptId).toBe('r1')
    expect(calls).toHaveLength(0)
  })

  it('refreshes via GET /v2/stores/:storeId/authority when the cache is stale', async () => {
    const dir = await tmpConfigDir()
    const stale: CachedAuthorityV2 = {
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      receiptId: 'r1',
      receipt: makeReceipt('r1'),
      serverUrl: SERVER_URL,
      checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      auditStatus: 'ok',
    }
    await writeCachedAuthority(dir, stale)

    const updated: AuthorityRefreshWire = {
      status: 'updated',
      receipt: makeReceipt('r2'),
      expiresAt: new Date(Date.now() + AUTHORITY_TTL_MS).toISOString(),
      auditStatus: 'audit_pending',
    }
    const { fetch: stub, calls } = mockFetchOnce(updated)
    const resolved = await resolveAuthority({
      configDir: dir,
      serverUrl: SERVER_URL,
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      token: 'token',
      fetch: stub,
    })

    expect(resolved.receiptId).toBe('r2')
    expect(resolved.auditStatus).toBe('audit_pending')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain(`/v2/stores/${STORE_ID}/authority`)
    expect(calls[0]!.url).toContain('knownReceiptId=r1')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer token')

    const persisted = await getCachedAuthority(dir, STORE_ID)
    expect(persisted?.receiptId).toBe('r2')
  })

  it('--refresh forces a refresh even when the cache is fresh', async () => {
    const dir = await tmpConfigDir()
    const fresh: CachedAuthorityV2 = {
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      receiptId: 'r1',
      receipt: makeReceipt('r1'),
      serverUrl: SERVER_URL,
      checkedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + AUTHORITY_TTL_MS).toISOString(),
      auditStatus: 'ok',
    }
    await writeCachedAuthority(dir, fresh)

    const { fetch: stub, calls } = mockFetchOnce({
      status: 'unchanged',
      receiptId: 'r1',
      expiresAt: new Date(Date.now() + AUTHORITY_TTL_MS).toISOString(),
      auditStatus: 'drift',
    })
    const resolved = await resolveAuthority({
      configDir: dir,
      serverUrl: SERVER_URL,
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      token: 'token',
      forceRefresh: true,
      fetch: stub,
    })

    expect(calls).toHaveLength(1)
    expect(resolved.receiptId).toBe('r1')
    expect(resolved.auditStatus).toBe('drift')
  })

  it('--offline returns the cached record', async () => {
    const dir = await tmpConfigDir()
    const cached: CachedAuthorityV2 = {
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      receiptId: 'r-offline',
      receipt: makeReceipt('r-offline'),
      serverUrl: SERVER_URL,
      checkedAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 24 * 60 * 60_000 + AUTHORITY_TTL_MS).toISOString(),
      auditStatus: 'ok',
    }
    await writeCachedAuthority(dir, cached)

    const { fetch: stub, calls } = mockFetchOnce({ status: 500, body: { code: 'BOOM' } })
    const resolved = await resolveAuthority({
      configDir: dir,
      serverUrl: SERVER_URL,
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      token: 'token',
      offline: true,
      fetch: stub,
    })

    expect(resolved.receiptId).toBe('r-offline')
    expect(calls).toHaveLength(0)
  })

  it('--offline fails closed when no cache exists', async () => {
    const dir = await tmpConfigDir()
    await expect(
      resolveAuthority({
        configDir: dir,
        serverUrl: SERVER_URL,
        tenantId: TENANT_ID,
        storeId: STORE_ID,
        token: 'token',
        offline: true,
        fetch: mockFetchOnce({ status: 500, body: {} }).fetch,
      }),
    ).rejects.toBeInstanceOf(AuthorityResolveError)
  })

  it('refresh raises AuthorityResolveError on gone_or_forbidden', async () => {
    const dir = await tmpConfigDir()
    const { fetch: stub } = mockFetchOnce({ status: 'gone_or_forbidden' })
    await expect(
      refreshAuthorityNow({
        configDir: dir,
        serverUrl: SERVER_URL,
        tenantId: TENANT_ID,
        storeId: STORE_ID,
        token: 'token',
        fetch: stub,
      }),
    ).rejects.toBeInstanceOf(AuthorityResolveError)
  })

  it('persists the cache file at mode 0600', async () => {
    const dir = await tmpConfigDir()
    const cached: CachedAuthorityV2 = {
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      receiptId: 'r-perm',
      receipt: makeReceipt('r-perm'),
      serverUrl: SERVER_URL,
      checkedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + AUTHORITY_TTL_MS).toISOString(),
      auditStatus: 'ok',
    }
    await writeCachedAuthority(dir, cached)
    const file = path.join(dir, `${STORE_ID}.json`)
    const stats = await stat(file)
    const mode = stats.mode & 0o777
    expect(mode & 0o077).toBe(0)
  })
})
