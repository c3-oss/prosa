// CQ-152 — focused test for the with412RefreshAndRetry helper.

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PromotionReceiptV2 } from '@c3-oss/prosa-types-v2'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AUTHORITY_TTL_MS, writeCachedAuthority } from '../../src/cli/v2/authority/index.js'
import { AuthorityChangedHttpError, V2ReadsClient } from '../../src/cli/v2/client/index.js'
import { with412RefreshAndRetry } from '../../src/cli/v2/commands/read/common.js'
import type { V2ReadContextRemote } from '../../src/cli/v2/read-context.js'

const TENANT = 'tenant-x'
const STORE = 'store-x'
const SERVER = 'http://test.invalid'

function makeReceipt(receiptId: string): PromotionReceiptV2 {
  return {
    payload: {
      receiptVersion: 2,
      receiptId,
      tenantId: TENANT,
      storeId: STORE,
      bundleRoot: 'b3',
      rawSourceRoot: 'b3',
      sealedAt: '2026-05-20T00:00:00.000Z',
      epoch: 1,
      schemaVersion: 'v2',
    } as unknown as PromotionReceiptV2['payload'],
    signature: {
      algorithm: 'ed25519',
      keyId: 'k',
      signedBytes: 'AAA=',
      signature: 'AAA=',
    } as PromotionReceiptV2['signature'],
  }
}

async function makeRemoteCtx(authorityDir: string): Promise<V2ReadContextRemote> {
  await writeCachedAuthority(authorityDir, {
    tenantId: TENANT,
    storeId: STORE,
    receiptId: 'r-old',
    receipt: makeReceipt('r-old'),
    serverUrl: SERVER,
    checkedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + AUTHORITY_TTL_MS).toISOString(),
    auditStatus: 'ok',
  })
  return {
    kind: 'remote',
    client: new V2ReadsClient({ baseUrl: SERVER, token: 'tok', tenantId: TENANT }),
    authority: {
      tenantId: TENANT,
      storeId: STORE,
      receiptId: 'r-old',
      receipt: makeReceipt('r-old'),
      serverUrl: SERVER,
      checkedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + AUTHORITY_TTL_MS).toISOString(),
      auditStatus: 'ok',
    },
    entry: {
      url: SERVER,
      token: 'tok',
    },
    storePath: '/tmp/store',
    storeId: STORE,
  }
}

describe('with412RefreshAndRetry — CQ-152', () => {
  let authDir: string
  let originalAuthorityDir: string | undefined

  beforeEach(async () => {
    authDir = await mkdtemp(path.join(tmpdir(), 'prosa-412-retry-'))
    originalAuthorityDir = process.env.PROSA_AUTHORITY_DIR
    process.env.PROSA_AUTHORITY_DIR = authDir
  })

  afterEach(async () => {
    if (originalAuthorityDir === undefined) process.env.PROSA_AUTHORITY_DIR = undefined
    else process.env.PROSA_AUTHORITY_DIR = originalAuthorityDir
    await import('node:fs/promises').then((m) => m.rm(authDir, { recursive: true, force: true }))
  })

  it('returns the result on first attempt success', async () => {
    const ctx = await makeRemoteCtx(authDir)
    const out = await with412RefreshAndRetry(ctx, async () => ({ count: 7 }))
    expect(out).toEqual({ count: 7 })
  })

  it('passes through non-412 errors unchanged', async () => {
    const ctx = await makeRemoteCtx(authDir)
    await expect(
      with412RefreshAndRetry(ctx, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
  })

  it('passes through local context errors without retry', async () => {
    await expect(
      with412RefreshAndRetry({ kind: 'local', storePath: '/tmp/x' }, async () => {
        throw new AuthorityChangedHttpError('/v2/reads/sessions/count')
      }),
    ).rejects.toBeInstanceOf(AuthorityChangedHttpError)
  })
})
