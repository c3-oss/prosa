// CQ-138 (CLI receipt validation): `promoteBundleV2` must reject
// a server response carrying a malformed, tuple-mismatched, or
// wrongly signed receipt. The route trusts the server to verify
// its own receipts (CQ-125, CQ-136, CQ-138), but a hostile proxy
// or partial corruption between server and CLI is exactly what
// client-side validation protects against — the CLI should
// surface a `PromoteV2Error` rather than persist a bogus receipt
// as authority.

import { buildApp, createAuth, loadConfig, openPgliteDatabase } from '@c3-oss/prosa-api'
import { buildCasPack } from '@c3-oss/prosa-bundle-v2'
import { applySchema } from '@c3-oss/prosa-db'
import { applyV2PromotionSubsetSchema } from '@c3-oss/prosa-db-v2'
import { MemoryObjectStore } from '@c3-oss/prosa-storage'
import { PGlite } from '@electric-sql/pglite'
import { blake3 } from '@noble/hashes/blake3'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type PromoteHttpClient,
  type PromoteHttpRequest,
  type PromoteHttpResponse,
  PromoteV2Error,
  promoteBundleV2,
} from '../../../../src/cli/v2/sync/promote.js'

function transportHashOf(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of blake3(bytes)) hex += byte.toString(16).padStart(2, '0')
  return `blake3:${hex}`
}

async function buildTestApp(): Promise<{ app: FastifyInstance; pglite: PGlite; close: () => Promise<void> }> {
  const config = loadConfig({
    PROSA_RUNTIME_MODE: 'test',
    PROSA_OBJECT_STORE_DRIVER: 'memory',
    PROSA_AUTH_SECRET: 'test-secret-1234567890abcdef',
    PROSA_API_URL: 'http://127.0.0.1:3000',
  } as NodeJS.ProcessEnv)
  const pglite = new PGlite()
  await applySchema(pglite)
  await applyV2PromotionSubsetSchema(pglite)
  const db = openPgliteDatabase(pglite)
  const auth = createAuth({ config, db: db.db })
  const app = await buildApp({
    config,
    auth,
    db: db.db,
    rawExec: db.rawExec,
    transaction: db.transaction,
    objectStore: new MemoryObjectStore(),
    loggerEnabled: false,
  })
  return {
    app,
    pglite,
    close: async () => {
      await app.close()
      await pglite.close()
    },
  }
}

async function signup(
  app: FastifyInstance,
  email: string,
  tenantName: string,
  tenantSlug: string,
): Promise<{ token: string; tenantId: string }> {
  const r = await app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: { email, password: 'correct-horse-battery', name: email, tenantName, tenantSlug } as never,
  })
  expect(r.statusCode).toBe(200)
  const data = (r.json() as { result: { data: { token: string; tenant: { id: string } } } }).result.data
  return { token: data.token, tenantId: data.tenant.id }
}

function makeBaseClient(app: FastifyInstance, token: string): PromoteHttpClient {
  return async (req: PromoteHttpRequest) => {
    const headers = { ...req.headers, authorization: `Bearer ${token}` }
    const payload =
      req.body == null ? undefined : req.body instanceof Uint8Array ? Buffer.from(req.body) : (req.body as object)
    const response = await app.inject({ method: req.method, url: req.url, headers, payload: payload as never })
    return {
      statusCode: response.statusCode,
      json: () => response.json(),
    }
  }
}

function makeTamperingClient(
  base: PromoteHttpClient,
  tamper: (url: string, body: unknown) => unknown,
): PromoteHttpClient {
  return async (req) => {
    const real = await base(req)
    if (req.url === '/v2/promotions/begin' || /\/seal$/.test(req.url)) {
      const tampered = tamper(req.url, real.json())
      return {
        statusCode: real.statusCode,
        json: () => tampered,
      }
    }
    return real
  }
}

function buildBundleHead(opts: { storeId: string; bundleRoot: string }) {
  return {
    bundleFormat: 2 as const,
    storeId: opts.storeId,
    storePath: '/home/test/store',
    epoch: 0,
    parserVersion: '0.1.0',
    createdAt: '2026-05-20T00:00:00.000Z',
    previousBundleRoot: null,
    bundleRoot: opts.bundleRoot,
    rawSourceRoot: 'ee'.repeat(32),
    manifestDigest: `blake3:${'ff'.repeat(32)}`,
    counts: {
      sourceFiles: 0,
      rawRecords: 0,
      objects: 1,
      sessions: 1,
      messages: 1,
      events: 0,
      contentBlocks: 0,
      turns: 0,
      toolCalls: 0,
      toolResults: 0,
      artifacts: 0,
      edges: 0,
      searchDocs: 1,
      projectionRows: 2,
    },
    segments: [],
  }
}

function buildFixture() {
  const objectInventoryBytes = new TextEncoder().encode('cq138-obj-inv')
  const projectionInventoryBytes = new TextEncoder().encode('cq138-proj-inv')
  const pack = buildCasPack([{ bytes: new TextEncoder().encode('cq138-payload-1'), compression: 'zstd' }], {
    createdAt: '2026-05-20T00:00:00.000Z',
  })
  return {
    objectInventory: {
      bytes: objectInventoryBytes,
      ref: {
        segmentId: 'cq138-seg-obj-inv',
        kind: 'inventory_object' as const,
        digest: transportHashOf(objectInventoryBytes),
        logicalRoot: 'objects/inv',
        compression: 'zstd' as const,
        byteLength: objectInventoryBytes.byteLength,
      },
    },
    projectionInventory: {
      bytes: projectionInventoryBytes,
      ref: {
        segmentId: 'cq138-seg-proj-inv',
        kind: 'inventory_projection' as const,
        digest: transportHashOf(projectionInventoryBytes),
        logicalRoot: 'projection/inv',
        compression: 'zstd' as const,
        byteLength: projectionInventoryBytes.byteLength,
      },
    },
    pack,
  }
}

describe('CQ-138: promoteBundleV2 rejects malformed / tampered / wrongly-signed receipts', () => {
  let t: { app: FastifyInstance; pglite: PGlite; close: () => Promise<void> } | null = null
  beforeEach(async () => {
    t = await buildTestApp()
  })
  afterEach(async () => {
    await t?.close()
  })

  it('throws PromoteV2Error when SealPromotion returns a payload whose derived id no longer matches', async () => {
    const account = await signup(t!.app, 'cq138-derived@example.com', 'Acme', 'acme-cq138-derived')
    const base = makeBaseClient(t!.app, account.token)
    const fx = buildFixture()
    const head = buildBundleHead({ storeId: 'store-cq138-derived', bundleRoot: '11'.repeat(32) })

    const tampering = makeTamperingClient(base, (url, body) => {
      if (/\/seal$/.test(url)) {
        const b = body as { status: string; receipt: { payload: Record<string, unknown> } }
        // Flip a non-tuple field after the server signed the
        // payload. deriveReceiptId(payload) will no longer match
        // payload.receiptId.
        b.receipt.payload.serverRegion = 'tampered'
        return b
      }
      return body
    })

    await expect(
      promoteBundleV2(tampering, {
        tenantId: account.tenantId,
        storeId: 'store-cq138-derived',
        storePath: '/home/test/store',
        deviceId: 'dev-cq138',
        head,
        objectInventory: fx.objectInventory,
        projectionInventory: fx.projectionInventory,
        objectPacks: [{ bytes: fx.pack.bytes }],
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof PromoteV2Error && err.step === 'seal' && /deriveReceiptId|hashes/i.test(err.message)
    })
  })

  it('throws PromoteV2Error when SealPromotion returns a payload with a forged signature', async () => {
    const account = await signup(t!.app, 'cq138-sig@example.com', 'Acme', 'acme-cq138-sig')
    const base = makeBaseClient(t!.app, account.token)
    const fx = buildFixture()
    const head = buildBundleHead({ storeId: 'store-cq138-sig', bundleRoot: '22'.repeat(32) })

    const tampering = makeTamperingClient(base, (url, body) => {
      if (/\/seal$/.test(url)) {
        const b = body as { status: string; receipt: { signature: { sig: string } } }
        // Replace the signature bytes with a length-correct zero
        // buffer. The keyId is still a real published key, so
        // JWKS lookup succeeds but cryptographic verify fails.
        b.receipt.signature.sig = Buffer.alloc(64).toString('base64url')
        return b
      }
      return body
    })

    await expect(
      promoteBundleV2(tampering, {
        tenantId: account.tenantId,
        storeId: 'store-cq138-sig',
        storePath: '/home/test/store',
        deviceId: 'dev-cq138',
        head,
        objectInventory: fx.objectInventory,
        projectionInventory: fx.projectionInventory,
        objectPacks: [{ bytes: fx.pack.bytes }],
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof PromoteV2Error && err.step === 'seal' && /signature/i.test(err.message)
    })
  })

  it('throws PromoteV2Error when SealPromotion returns a malformed payload (missing required fields)', async () => {
    const account = await signup(t!.app, 'cq138-shape@example.com', 'Acme', 'acme-cq138-shape')
    const base = makeBaseClient(t!.app, account.token)
    const fx = buildFixture()
    const head = buildBundleHead({ storeId: 'store-cq138-shape', bundleRoot: '33'.repeat(32) })

    const tampering = makeTamperingClient(base, (url, body) => {
      if (/\/seal$/.test(url)) {
        const b = body as { status: string; receipt: { payload: Record<string, unknown> } }
        // Drop a required field. The schema parser rejects
        // before any cryptographic work.
        b.receipt.payload.counts = undefined
        return b
      }
      return body
    })

    await expect(
      promoteBundleV2(tampering, {
        tenantId: account.tenantId,
        storeId: 'store-cq138-shape',
        storePath: '/home/test/store',
        deviceId: 'dev-cq138',
        head,
        objectInventory: fx.objectInventory,
        projectionInventory: fx.projectionInventory,
        objectPacks: [{ bytes: fx.pack.bytes }],
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof PromoteV2Error && err.step === 'seal' && /promotionReceiptV2Schema/i.test(err.message)
    })
  })

  it('throws PromoteV2Error when BeginPromotion already_promoted returns a tampered receipt on retry', async () => {
    const account = await signup(t!.app, 'cq138-already@example.com', 'Acme', 'acme-cq138-already')
    const base = makeBaseClient(t!.app, account.token)
    const fx = buildFixture()
    const head = buildBundleHead({ storeId: 'store-cq138-already', bundleRoot: '44'.repeat(32) })

    // First call: real seal — no tampering.
    const firstResult = await promoteBundleV2(base, {
      tenantId: account.tenantId,
      storeId: 'store-cq138-already',
      storePath: '/home/test/store',
      deviceId: 'dev-cq138',
      head,
      objectInventory: fx.objectInventory,
      projectionInventory: fx.projectionInventory,
      objectPacks: [{ bytes: fx.pack.bytes }],
    })
    expect(firstResult.status).toBe('sealed')

    // Second call: same bundle → already_promoted fast path,
    // but the proxy tampers with the receipt payload before
    // returning. The CLI must reject.
    const tampering = makeTamperingClient(base, (url, body) => {
      if (url === '/v2/promotions/begin') {
        const b = body as { status: string; receipt?: { payload: Record<string, unknown> } }
        if (b.status === 'already_promoted' && b.receipt) {
          b.receipt.payload.serverRegion = 'tampered-on-replay'
        }
        return b
      }
      return body
    })

    await expect(
      promoteBundleV2(tampering, {
        tenantId: account.tenantId,
        storeId: 'store-cq138-already',
        storePath: '/home/test/store',
        deviceId: 'dev-cq138',
        head,
        objectInventory: fx.objectInventory,
        projectionInventory: fx.projectionInventory,
        objectPacks: [{ bytes: fx.pack.bytes }],
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof PromoteV2Error && err.step === 'begin' && /deriveReceiptId|hashes/i.test(err.message)
    })
  })

  it('returns sealed result cleanly when the receipt is intact (no tampering)', async () => {
    const account = await signup(t!.app, 'cq138-happy@example.com', 'Acme', 'acme-cq138-happy')
    const base = makeBaseClient(t!.app, account.token)
    const fx = buildFixture()
    const head = buildBundleHead({ storeId: 'store-cq138-happy', bundleRoot: '55'.repeat(32) })

    const result = await promoteBundleV2(base, {
      tenantId: account.tenantId,
      storeId: 'store-cq138-happy',
      storePath: '/home/test/store',
      deviceId: 'dev-cq138',
      head,
      objectInventory: fx.objectInventory,
      projectionInventory: fx.projectionInventory,
      objectPacks: [{ bytes: fx.pack.bytes }],
    })
    expect(result.status).toBe('sealed')
  })
})
