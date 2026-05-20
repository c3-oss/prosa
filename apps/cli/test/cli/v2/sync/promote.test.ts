// Lane 5 slice 7 — end-to-end client + server promotion via in-process
// Fastify inject.
//
// Builds the API test app from `@c3-oss/prosa-api`, signs up a tenant,
// constructs a real CAS pack via `@c3-oss/prosa-bundle-v2`, and drives
// the full BeginPromotion → UploadSegment(s) → UploadObjectPack →
// SealPromotion sequence through `promoteBundleV2`. Then asserts the
// sealed receipt verifies against the published JWKS, and that a
// second promotion of the same bundle takes the `already_promoted`
// fast path.
//
// The promote function exposes a generic `PromoteHttpClient`; the test
// adapter wraps Fastify's `app.inject` so server + canonical types +
// CLI client all exercise together without a network bind.

import { buildApp, createAuth, loadConfig, openPgliteDatabase } from '@c3-oss/prosa-api'
import { buildCasPack } from '@c3-oss/prosa-bundle-v2'
import { applySchema } from '@c3-oss/prosa-db'
import { applyV2PromotionSubsetSchema } from '@c3-oss/prosa-db-v2'
import { MemoryObjectStore } from '@c3-oss/prosa-storage'
import { receiptPayloadBytes } from '@c3-oss/prosa-types-v2'
import { PGlite } from '@electric-sql/pglite'
import { blake3 } from '@noble/hashes/blake3'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type PromoteHttpClient, promoteBundleV2 } from '../../../../src/cli/v2/sync/promote.js'

function transportHashOf(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of blake3(bytes)) hex += byte.toString(16).padStart(2, '0')
  return `blake3:${hex}`
}

type TestApp = {
  app: FastifyInstance
  pglite: PGlite
  close: () => Promise<void>
}

async function buildPromoteTestApp(): Promise<TestApp> {
  const config = loadConfig({
    PROSA_RUNTIME_MODE: 'test',
    PROSA_OBJECT_STORE_DRIVER: 'memory',
    PROSA_AUTH_SECRET: 'test-secret-1234567890abcdef',
    PROSA_API_URL: 'http://127.0.0.1:3000',
  } as NodeJS.ProcessEnv)
  const pglite = new PGlite()
  await applySchema(pglite)
  // CQ-124: use the canonical conflict-free subset helper so
  // server + CLI tests both go through the same boot path.
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

async function signupWithTenant(
  app: FastifyInstance,
  email: string,
  tenantName: string,
  tenantSlug: string,
): Promise<{ token: string; tenantId: string; userId: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: { email, password: 'correct-horse-battery', name: email, tenantName, tenantSlug } as never,
  })
  expect(response.statusCode).toBe(200)
  const data = (
    response.json() as {
      result: { data: { token: string; user: { id: string }; tenant: { id: string } } }
    }
  ).result.data
  return { token: data.token, tenantId: data.tenant.id, userId: data.user.id }
}

function makeInjectClient(app: FastifyInstance, token: string): PromoteHttpClient {
  return async (req) => {
    const headers = {
      ...req.headers,
      authorization: `Bearer ${token}`,
    }
    const payload =
      req.body == null ? undefined : req.body instanceof Uint8Array ? Buffer.from(req.body) : (req.body as object)
    const response = await app.inject({ method: req.method, url: req.url, headers, payload: payload as never })
    return {
      statusCode: response.statusCode,
      json: () => response.json(),
    }
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
      objects: 2,
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

function buildPromoteFixture() {
  const objectInventoryBytes = new TextEncoder().encode('cli-object-inventory-arrow-zst')
  const projectionInventoryBytes = new TextEncoder().encode('cli-projection-inventory-arrow-zst')
  const pack = buildCasPack(
    [
      { bytes: new TextEncoder().encode('alpha-cli-payload-1'), compression: 'zstd' },
      { bytes: new TextEncoder().encode('bravo-cli-payload-2'), compression: 'zstd' },
    ],
    { createdAt: '2026-05-20T00:00:00.000Z' },
  )
  return {
    objectInventory: {
      bytes: objectInventoryBytes,
      ref: {
        segmentId: 'cli-seg-obj-inv',
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
        segmentId: 'cli-seg-proj-inv',
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

describe('promoteBundleV2 — end-to-end (Lane 5 slice 7)', () => {
  let app: TestApp | null = null
  beforeEach(async () => {
    app = await buildPromoteTestApp()
  })
  afterEach(async () => {
    await app?.close()
  })

  it('drives the full four-call protocol and seals a fresh bundle', async () => {
    const { app: fastify } = app!
    const account = await signupWithTenant(fastify, 'cli-promote@example.com', 'Acme', 'acme-cli')
    const client = makeInjectClient(fastify, account.token)
    const fx = buildPromoteFixture()
    const bundleRoot = '11'.repeat(32)

    const result = await promoteBundleV2(client, {
      tenantId: account.tenantId,
      storeId: 'store-cli',
      storePath: '/home/test/store',
      deviceId: 'dev-cli',
      head: buildBundleHead({ storeId: 'store-cli', bundleRoot }),
      objectInventory: fx.objectInventory,
      projectionInventory: fx.projectionInventory,
      objectPacks: [{ bytes: fx.pack.bytes }],
    })

    expect(result.status).toBe('sealed')
    if (result.status !== 'sealed') return
    expect(result.receipt.payload.bundleRoot).toBe(bundleRoot)
    expect(result.receipt.signature.alg).toBe('Ed25519')

    // CQ-123: the seal-time receipt — carrying a real Better Auth
    // tenantId (organization.id, mixed-case nanoid) — must parse
    // against the canonical `promotionReceiptV2Schema`. This is
    // the end-to-end I5 + CQ-123 acceptance: real signup all the
    // way through to client-side schema-validated receipt.
    const { promotionReceiptV2Schema } = await import('@c3-oss/prosa-wire-v2')
    const schemaParse = promotionReceiptV2Schema.safeParse(result.receipt)
    if (!schemaParse.success) {
      // Surface the failure for fast debugging — without this the
      // test only shows `expected false to be true`.
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(schemaParse.error.issues, null, 2))
    }
    expect(schemaParse.success).toBe(true)
    // Confirm the tenantId really came from Better Auth (not a
    // helper-supplied lowercase fixture).
    expect(result.receipt.payload.tenantId).toBe(account.tenantId)

    // I5 — the signature returned to the client verifies against
    // the published JWKS.
    const jwks = await fastify.inject({ method: 'GET', url: '/v2/.well-known/receipt-keys.json' })
    const keys = (jwks.json() as { keys: Array<{ kid: string; x: string; kty: string; crv: string }> }).keys
    const key = keys.find((k) => k.kid === result.receipt.signature.keyId)
    expect(key).toBeDefined()
    const { createPublicKey, verify } = await import('node:crypto')
    const publicKey = createPublicKey({ key: { ...key!, alg: 'EdDSA' } as never, format: 'jwk' })
    const sigBytes = Buffer.from(result.receipt.signature.sig, 'base64url')
    const ok = verify(null, receiptPayloadBytes(result.receipt.payload), publicKey, sigBytes)
    expect(ok).toBe(true)
  })

  it('takes the already_promoted fast path on repeat with the same bundleRoot', async () => {
    const { app: fastify } = app!
    const account = await signupWithTenant(fastify, 'cli-fast@example.com', 'Acme', 'acme-cli-fast')
    const client = makeInjectClient(fastify, account.token)
    const fx = buildPromoteFixture()
    const head = buildBundleHead({ storeId: 'store-cli-fast', bundleRoot: '22'.repeat(32) })

    const first = await promoteBundleV2(client, {
      tenantId: account.tenantId,
      storeId: 'store-cli-fast',
      storePath: '/home/test/store',
      deviceId: 'dev-cli',
      head,
      objectInventory: fx.objectInventory,
      projectionInventory: fx.projectionInventory,
      objectPacks: [{ bytes: fx.pack.bytes }],
    })
    expect(first.status).toBe('sealed')
    const firstReceiptId = first.receipt.payload.receiptId

    // Second call with the same bundleRoot: server's BeginPromotion
    // returns `already_promoted` from remote_authority_v2.
    const second = await promoteBundleV2(client, {
      tenantId: account.tenantId,
      storeId: 'store-cli-fast',
      storePath: '/home/test/store',
      deviceId: 'dev-cli',
      head,
      objectInventory: fx.objectInventory,
      projectionInventory: fx.projectionInventory,
      objectPacks: [{ bytes: fx.pack.bytes }],
    })
    expect(second.status).toBe('already_promoted')
    expect(second.receipt.payload.receiptId).toBe(firstReceiptId)
  })

  it('resumes after a half-interrupt: re-running the same input does not re-upload the already-staged inventory', async () => {
    const { app: fastify } = app!
    const account = await signupWithTenant(fastify, 'cli-resume@example.com', 'Acme', 'acme-cli-resume')
    const client = makeInjectClient(fastify, account.token)
    const fx = buildPromoteFixture()
    const head = buildBundleHead({ storeId: 'store-cli-resume', bundleRoot: '44'.repeat(32) })

    // 1. Start the promotion, upload only the object inventory and
    //    then "crash" before uploading the projection inventory or the
    //    pack. We model the crash by driving the begin + first upload
    //    manually rather than through promoteBundleV2.
    const begin = await client({
      method: 'POST',
      url: '/v2/promotions/begin',
      headers: { 'content-type': 'application/json' },
      body: {
        protocolVersion: 2,
        tenantId: account.tenantId,
        storeId: 'store-cli-resume',
        storePath: '/home/test/store',
        head,
        inventories: {
          objectInventorySegment: fx.objectInventory.ref,
          projectionInventorySegment: fx.projectionInventory.ref,
        },
        device: { deviceId: 'dev-cli' },
      },
    })
    expect(begin.statusCode).toBe(200)
    const { promotionId } = begin.json() as { promotionId: string }
    const firstUpload = await client({
      method: 'PUT',
      url: `/v2/promotions/${promotionId}/segments/${fx.objectInventory.ref.segmentId}`,
      headers: {
        'content-type': 'application/octet-stream',
        'x-prosa-transport-hash': fx.objectInventory.ref.digest,
        'x-prosa-device-id': 'dev-cli',
      },
      body: fx.objectInventory.bytes,
    })
    expect(firstUpload.statusCode).toBe(200)

    // 2. Instrument the client to capture which routes the second
    //    promoteBundleV2 invocation actually calls. We expect the
    //    object inventory upload to be skipped.
    const calls: string[] = []
    const recordingClient: PromoteHttpClient = async (req) => {
      calls.push(`${req.method} ${req.url}`)
      return client(req)
    }

    const result = await promoteBundleV2(recordingClient, {
      tenantId: account.tenantId,
      storeId: 'store-cli-resume',
      storePath: '/home/test/store',
      deviceId: 'dev-cli',
      head,
      objectInventory: fx.objectInventory,
      projectionInventory: fx.projectionInventory,
      objectPacks: [{ bytes: fx.pack.bytes }],
    })
    expect(result.status).toBe('sealed')

    // The status fetch must have happened, the already-uploaded
    // object inventory PUT must have been skipped, the projection
    // inventory PUT must have happened, the pack POST must have
    // happened, and the seal POST must have happened.
    expect(calls).toEqual(
      expect.arrayContaining([
        'POST /v2/promotions/begin',
        `GET /v2/promotions/${promotionId}/status`,
        `PUT /v2/promotions/${promotionId}/segments/${fx.projectionInventory.ref.segmentId}`,
        `POST /v2/promotions/${promotionId}/object-packs`,
        `POST /v2/promotions/${promotionId}/seal`,
      ]),
    )
    expect(calls).not.toContain(`PUT /v2/promotions/${promotionId}/segments/${fx.objectInventory.ref.segmentId}`)
  })

  it('throws PromoteV2Error with the failing step + status code on server-side rejection', async () => {
    const { app: fastify } = app!
    const account = await signupWithTenant(fastify, 'cli-fail@example.com', 'Acme', 'acme-cli-fail')
    const client = makeInjectClient(fastify, account.token)
    const fx = buildPromoteFixture()

    // Corrupt the pack bytes so verifyCasPack rejects.
    const corrupted = new Uint8Array(fx.pack.bytes.byteLength)
    corrupted.fill(0x42)

    await expect(
      promoteBundleV2(client, {
        tenantId: account.tenantId,
        storeId: 'store-cli-fail',
        storePath: '/home/test/store',
        deviceId: 'dev-cli',
        head: buildBundleHead({ storeId: 'store-cli-fail', bundleRoot: '33'.repeat(32) }),
        objectInventory: fx.objectInventory,
        projectionInventory: fx.projectionInventory,
        objectPacks: [{ bytes: corrupted }],
      }),
    ).rejects.toMatchObject({ step: 'upload-pack', statusCode: 400 })
  })
})
