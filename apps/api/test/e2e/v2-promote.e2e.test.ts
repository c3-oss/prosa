// Lane 5 acceptance E2E — drives the v2 promotion protocol against a
// real Postgres 16 + MinIO/S3 stack from `docker-compose.test.yml`.
//
// Skipped unless `PROSA_TEST_POSTGRES_URL` and the `PROSA_TEST_S3_*`
// env vars are set; the v1 e2e suite uses the same gating.
//
// What this proves:
//
// 1. A fresh `BeginPromotion → UploadSegment(s) → UploadObjectPack →
//    SealPromotion` sequence succeeds against real Postgres + real S3.
// 2. Re-promoting the same bundle returns the `already_promoted` fast
//    path and completes in well under the 2 s acceptance budget.
// 3. The receipt signature returned to the client verifies against the
//    server's published JWKS (invariant I5).
// 4. `GET /v2/receipts/:receiptId` returns the same bytes for the
//    owning tenant; a second tenant gets `RECEIPT_NOT_FOUND`
//    (invariant I1 — second-device read isolation).
// 5. The resume / status-fetch path skips already-uploaded inventory
//    segments without re-transmitting bytes.
//
// Each test reads the env vars at run time and creates an isolated
// API app + signed-up tenants. The Postgres schema is reset between
// runs so previous receipts don't bleed in.

import path from 'node:path'
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { buildCasPack } from '@c3-oss/prosa-bundle-v2'
import { applySchema } from '@c3-oss/prosa-db'
import { PACKS_SCHEMA_SQL, PROMOTION_SCHEMA_SQL } from '@c3-oss/prosa-db-v2'
import { S3ObjectStore } from '@c3-oss/prosa-storage'
import { receiptPayloadBytes } from '@c3-oss/prosa-types-v2'
import { blake3 } from '@noble/hashes/blake3'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { createAuth } from '../../src/auth.js'
import { loadConfig } from '../../src/config.js'
import { openPostgresDatabase } from '../../src/db.js'

const PG_URL = process.env.PROSA_TEST_POSTGRES_URL
const S3_ENDPOINT = process.env.PROSA_TEST_S3_ENDPOINT
const S3_BUCKET = process.env.PROSA_TEST_S3_BUCKET ?? 'prosa-test-v2'
const S3_ACCESS_KEY = process.env.PROSA_TEST_S3_ACCESS_KEY
const S3_SECRET_KEY = process.env.PROSA_TEST_S3_SECRET_KEY
const S3_REGION = process.env.PROSA_TEST_S3_REGION ?? 'us-east-1'

const shouldRun = Boolean(PG_URL && S3_ENDPOINT && S3_ACCESS_KEY && S3_SECRET_KEY)

function transportHashOf(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of blake3(bytes)) hex += byte.toString(16).padStart(2, '0')
  return `blake3:${hex}`
}

async function resetPostgresSchema(pgUrl: string): Promise<void> {
  const bootstrap = postgres(pgUrl, { max: 1, prepare: false })
  try {
    await bootstrap.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
    await applySchema({ exec: async (sql) => void (await bootstrap.unsafe(sql)) })
    await bootstrap.unsafe(PROMOTION_SCHEMA_SQL)
    await bootstrap.unsafe(PACKS_SCHEMA_SQL.replace(/CREATE TABLE IF NOT EXISTS remote_object[\s\S]*?\);/u, ''))
    await bootstrap.unsafe(`
      CREATE TABLE IF NOT EXISTS search_generation_current (
        tenant_id              TEXT PRIMARY KEY,
        generation_id          TEXT NOT NULL,
        receipt_id             TEXT NOT NULL,
        promoted_at            TIMESTAMPTZ NOT NULL,
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `)
  } finally {
    await bootstrap.end({ timeout: 2 })
  }
}

async function ensureBucket(): Promise<void> {
  const s3 = new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    credentials: { accessKeyId: S3_ACCESS_KEY!, secretAccessKey: S3_SECRET_KEY! },
    forcePathStyle: true,
  })
  try {
    await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }))
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }))
  }
}

type E2EApp = {
  app: FastifyInstance
  close: () => Promise<void>
}

async function buildE2EApp(): Promise<E2EApp> {
  await resetPostgresSchema(PG_URL!)
  await ensureBucket()
  const config = loadConfig({
    PROSA_RUNTIME_MODE: 'test',
    PROSA_OBJECT_STORE_DRIVER: 's3',
    PROSA_OBJECT_STORE_BUCKET: S3_BUCKET,
    PROSA_OBJECT_STORE_ENDPOINT: S3_ENDPOINT,
    PROSA_OBJECT_STORE_REGION: S3_REGION,
    PROSA_OBJECT_STORE_ACCESS_KEY_ID: S3_ACCESS_KEY,
    PROSA_OBJECT_STORE_SECRET_ACCESS_KEY: S3_SECRET_KEY,
    PROSA_AUTH_SECRET: 'test-secret-1234567890abcdef',
    PROSA_API_URL: 'http://127.0.0.1:3000',
    PROSA_DATABASE_URL: PG_URL,
  } as NodeJS.ProcessEnv)
  const dbHandle = await openPostgresDatabase(PG_URL!)
  const auth = createAuth({ config, db: dbHandle.db })
  const objectStore = new S3ObjectStore({
    bucket: S3_BUCKET,
    endpoint: S3_ENDPOINT!,
    region: S3_REGION,
    accessKeyId: S3_ACCESS_KEY!,
    secretAccessKey: S3_SECRET_KEY!,
    forcePathStyle: true,
  })
  const app = await buildApp({
    config,
    auth,
    db: dbHandle.db,
    rawExec: dbHandle.rawExec,
    transaction: dbHandle.transaction,
    objectStore,
    loggerEnabled: false,
  })
  return {
    app,
    close: async () => {
      await app.close()
      await dbHandle.close()
    },
  }
}

async function signupTenant(
  app: FastifyInstance,
  email: string,
  tenantName: string,
  tenantSlug: string,
): Promise<{ token: string; tenantId: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: { email, password: 'correct-horse-battery', name: email, tenantName, tenantSlug } as never,
  })
  if (response.statusCode !== 200) {
    throw new Error(`signup failed: ${response.statusCode} ${response.body}`)
  }
  const data = (
    response.json() as {
      result: { data: { token: string; tenant: { id: string } } }
    }
  ).result.data
  return { token: data.token, tenantId: data.tenant.id }
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
    rawSourceRoot: '11'.repeat(32),
    manifestDigest: `blake3:${'22'.repeat(32)}`,
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

function buildFixture() {
  const objBytes = new TextEncoder().encode(`e2e-object-inventory-${path.basename(__filename)}`)
  const projBytes = new TextEncoder().encode(`e2e-projection-inventory-${path.basename(__filename)}`)
  const pack = buildCasPack(
    [
      { bytes: new TextEncoder().encode(`alpha-e2e-${Date.now()}`), compression: 'zstd' },
      { bytes: new TextEncoder().encode(`bravo-e2e-${Date.now()}`), compression: 'zstd' },
    ],
    { createdAt: '2026-05-20T00:00:00.000Z' },
  )
  return {
    pack,
    objBytes,
    projBytes,
    objDigest: transportHashOf(objBytes),
    projDigest: transportHashOf(projBytes),
  }
}

async function drivePromotion(opts: {
  app: FastifyInstance
  token: string
  tenantId: string
  storeId: string
  bundleRoot: string
  fx: ReturnType<typeof buildFixture>
}): Promise<{
  promotionId: string
  sealResponse: {
    receipt: {
      payload: Record<string, unknown> & { receiptId: string }
      signature: Record<string, unknown> & { sig: string; keyId: string; alg: string }
    }
  }
}> {
  const { app, token, tenantId, storeId, bundleRoot, fx } = opts
  const begin = await app.inject({
    method: 'POST',
    url: '/v2/promotions/begin',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: {
      protocolVersion: 2,
      tenantId,
      storeId,
      storePath: '/home/test/store',
      head: buildBundleHead({ storeId, bundleRoot }),
      inventories: {
        objectInventorySegment: {
          segmentId: 'e2e-obj-inv',
          kind: 'inventory_object',
          digest: fx.objDigest,
          logicalRoot: 'objects/inv',
          compression: 'zstd',
          byteLength: fx.objBytes.byteLength,
        },
        projectionInventorySegment: {
          segmentId: 'e2e-proj-inv',
          kind: 'inventory_projection',
          digest: fx.projDigest,
          logicalRoot: 'projection/inv',
          compression: 'zstd',
          byteLength: fx.projBytes.byteLength,
        },
      },
      device: { deviceId: 'e2e-device' },
    } as never,
  })
  expect(begin.statusCode).toBe(200)
  const { promotionId } = begin.json() as { promotionId: string }

  for (const [segmentId, bytes, digest] of [
    ['e2e-obj-inv', fx.objBytes, fx.objDigest] as const,
    ['e2e-proj-inv', fx.projBytes, fx.projDigest] as const,
  ]) {
    const r = await app.inject({
      method: 'PUT',
      url: `/v2/promotions/${promotionId}/segments/${segmentId}`,
      headers: {
        'content-type': 'application/octet-stream',
        authorization: `Bearer ${token}`,
        'x-prosa-transport-hash': digest,
      },
      payload: Buffer.from(bytes),
    })
    expect(r.statusCode).toBe(200)
  }

  const upPack = await app.inject({
    method: 'POST',
    url: `/v2/promotions/${promotionId}/object-packs`,
    headers: {
      'content-type': 'application/octet-stream',
      authorization: `Bearer ${token}`,
      'x-prosa-transport-hash': transportHashOf(fx.pack.bytes),
    },
    payload: Buffer.from(fx.pack.bytes),
  })
  expect(upPack.statusCode).toBe(200)

  const seal = await app.inject({
    method: 'POST',
    url: `/v2/promotions/${promotionId}/seal`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: {} as never,
  })
  expect(seal.statusCode).toBe(200)
  return { promotionId, sealResponse: seal.json() as never }
}

describe.skipIf(!shouldRun)('Lane 5 E2E — v2 promotion against real Postgres + MinIO', () => {
  let handle: E2EApp | null = null
  beforeEach(async () => {
    handle = await buildE2EApp()
  })
  afterEach(async () => {
    await handle?.close()
  })

  it('seals a fresh bundle, fast-paths the repeat in < 2 s, and the receipt verifies against JWKS', async () => {
    const { app } = handle!
    const account = await signupTenant(app, 'e2e-v2-ok@example.com', 'Acme', 'acme-e2e-v2-ok')
    const fx = buildFixture()
    const bundleRoot = 'aa'.repeat(32)

    // 1. Fresh promotion → sealed.
    const { sealResponse } = await drivePromotion({
      app,
      token: account.token,
      tenantId: account.tenantId,
      storeId: 'e2e-store',
      bundleRoot,
      fx,
    })
    const sealedReceiptId = sealResponse.receipt.payload.receiptId

    // 2. Re-promote the same bundle → already_promoted fast path under 2 s.
    const t0 = Date.now()
    const begin2 = await app.inject({
      method: 'POST',
      url: '/v2/promotions/begin',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
      payload: {
        protocolVersion: 2,
        tenantId: account.tenantId,
        storeId: 'e2e-store',
        storePath: '/home/test/store',
        head: buildBundleHead({ storeId: 'e2e-store', bundleRoot }),
        inventories: {
          objectInventorySegment: {
            segmentId: 'e2e-obj-inv',
            kind: 'inventory_object',
            digest: fx.objDigest,
            logicalRoot: 'objects/inv',
            compression: 'zstd',
            byteLength: fx.objBytes.byteLength,
          },
          projectionInventorySegment: {
            segmentId: 'e2e-proj-inv',
            kind: 'inventory_projection',
            digest: fx.projDigest,
            logicalRoot: 'projection/inv',
            compression: 'zstd',
            byteLength: fx.projBytes.byteLength,
          },
        },
        device: { deviceId: 'e2e-device' },
      } as never,
    })
    const elapsedMs = Date.now() - t0
    expect(begin2.statusCode).toBe(200)
    const begin2Body = begin2.json() as { status: string; receipt?: { payload: { receiptId: string } } }
    expect(begin2Body.status).toBe('already_promoted')
    expect(begin2Body.receipt?.payload.receiptId).toBe(sealedReceiptId)
    expect(elapsedMs).toBeLessThan(2000)

    // 3. JWKS verification (invariant I5).
    const jwksResponse = await app.inject({ method: 'GET', url: '/v2/.well-known/receipt-keys.json' })
    const keys = (jwksResponse.json() as { keys: Array<{ kid: string; x: string; crv: string; kty: string }> }).keys
    const key = keys.find((k) => k.kid === sealResponse.receipt.signature.keyId)
    expect(key).toBeDefined()
    const { createPublicKey, verify } = await import('node:crypto')
    const publicKey = createPublicKey({ key: { ...key!, alg: 'EdDSA' } as never, format: 'jwk' })
    const sigBytes = Buffer.from(sealResponse.receipt.signature.sig, 'base64url')
    const ok = verify(null, receiptPayloadBytes(sealResponse.receipt.payload as never), publicKey, sigBytes)
    expect(ok).toBe(true)
  })

  it('does not leak receipts across tenants on GET /v2/receipts (I1)', async () => {
    const { app } = handle!
    const accountA = await signupTenant(app, 'e2e-iso-a@example.com', 'A', 'acme-e2e-iso-a')
    const accountB = await signupTenant(app, 'e2e-iso-b@example.com', 'B', 'acme-e2e-iso-b')
    const fx = buildFixture()
    const { sealResponse } = await drivePromotion({
      app,
      token: accountA.token,
      tenantId: accountA.tenantId,
      storeId: 'e2e-iso-store',
      bundleRoot: 'bb'.repeat(32),
      fx,
    })
    const sealedId = sealResponse.receipt.payload.receiptId

    // Owning tenant fetches receipt successfully.
    const ok = await app.inject({
      method: 'GET',
      url: `/v2/receipts/${sealedId}`,
      headers: { authorization: `Bearer ${accountA.token}` },
    })
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as { receipt: { payload: { receiptId: string } } }).receipt.payload.receiptId).toBe(sealedId)

    // Different tenant gets 404.
    const denied = await app.inject({
      method: 'GET',
      url: `/v2/receipts/${sealedId}`,
      headers: { authorization: `Bearer ${accountB.token}` },
    })
    expect(denied.statusCode).toBe(404)
    expect((denied.json() as { code: string }).code).toBe('RECEIPT_NOT_FOUND')
  })

  it('resumes after a half-interrupt and seals without re-uploading staged inventory', async () => {
    const { app } = handle!
    const account = await signupTenant(app, 'e2e-resume@example.com', 'Acme', 'acme-e2e-resume')
    const fx = buildFixture()
    const bundleRoot = 'cc'.repeat(32)
    const storeId = 'e2e-resume-store'

    const begin = await app.inject({
      method: 'POST',
      url: '/v2/promotions/begin',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
      payload: {
        protocolVersion: 2,
        tenantId: account.tenantId,
        storeId,
        storePath: '/home/test/store',
        head: buildBundleHead({ storeId, bundleRoot }),
        inventories: {
          objectInventorySegment: {
            segmentId: 'e2e-obj-inv',
            kind: 'inventory_object',
            digest: fx.objDigest,
            logicalRoot: 'objects/inv',
            compression: 'zstd',
            byteLength: fx.objBytes.byteLength,
          },
          projectionInventorySegment: {
            segmentId: 'e2e-proj-inv',
            kind: 'inventory_projection',
            digest: fx.projDigest,
            logicalRoot: 'projection/inv',
            compression: 'zstd',
            byteLength: fx.projBytes.byteLength,
          },
        },
        device: { deviceId: 'e2e-device' },
      } as never,
    })
    expect(begin.statusCode).toBe(200)
    const { promotionId } = begin.json() as { promotionId: string }

    // Upload just the object inventory.
    await app.inject({
      method: 'PUT',
      url: `/v2/promotions/${promotionId}/segments/e2e-obj-inv`,
      headers: {
        'content-type': 'application/octet-stream',
        authorization: `Bearer ${account.token}`,
        'x-prosa-transport-hash': fx.objDigest,
      },
      payload: Buffer.from(fx.objBytes),
    })

    // Status reports one inventory uploaded, no packs.
    const status = await app.inject({
      method: 'GET',
      url: `/v2/promotions/${promotionId}/status`,
      headers: { authorization: `Bearer ${account.token}` },
    })
    expect(status.statusCode).toBe(200)
    const statusBody = status.json() as {
      inventories: { object: { uploaded: boolean }; projection: { uploaded: boolean } }
      uploadedPackDigests: string[]
    }
    expect(statusBody.inventories.object.uploaded).toBe(true)
    expect(statusBody.inventories.projection.uploaded).toBe(false)
    expect(statusBody.uploadedPackDigests).toEqual([])

    // Finish: projection inventory + pack + seal.
    await app.inject({
      method: 'PUT',
      url: `/v2/promotions/${promotionId}/segments/e2e-proj-inv`,
      headers: {
        'content-type': 'application/octet-stream',
        authorization: `Bearer ${account.token}`,
        'x-prosa-transport-hash': fx.projDigest,
      },
      payload: Buffer.from(fx.projBytes),
    })
    await app.inject({
      method: 'POST',
      url: `/v2/promotions/${promotionId}/object-packs`,
      headers: {
        'content-type': 'application/octet-stream',
        authorization: `Bearer ${account.token}`,
        'x-prosa-transport-hash': transportHashOf(fx.pack.bytes),
      },
      payload: Buffer.from(fx.pack.bytes),
    })
    const seal = await app.inject({
      method: 'POST',
      url: `/v2/promotions/${promotionId}/seal`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
      payload: {} as never,
    })
    expect(seal.statusCode).toBe(200)
    expect((seal.json() as { status: string }).status).toBe('sealed')
  })
})
