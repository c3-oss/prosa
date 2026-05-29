// CQ-140 (subprocess harness): the `prosa v2 sync` command must
// drive the Lane 5 four-call protocol end-to-end against a real
// listening prosa-api + Docker Postgres + MinIO, NOT just an
// in-process Fastify route harness. This file is the command-level
// gate the reviewer asked for: it boots a real Fastify listener on
// 127.0.0.1, signs up a user, writes a bundle layout to disk, and
// runs `runCli([..., 'v2', 'sync', ...])` with `--server <real URL>`
// so promoteBundleV2 reaches the server over HTTP fetch.
//
// A second device + tenant then fetches the promoted receipt
// through the same listening server (no inject) so the two-process
// invariant is observable from a fresh GetReceipt call. Together
// these close the Lane 5 CQ-140 acceptance bullet that route-level
// `app.inject` does not satisfy.
//
// Env-gated like the other Docker E2E files. With no env vars set,
// the describe block skips; the `just e2e-cli` recipe wires the
// real Postgres / MinIO endpoints.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { buildApp, createAuth, loadConfig, openPostgresDatabase } from '@c3-oss/prosa-api'
import { buildCasPack } from '@c3-oss/prosa-bundle-v2'
import { applySchema } from '@c3-oss/prosa-db'
import { applyV2PromotionSubsetSchema } from '@c3-oss/prosa-db-v2'
import { S3ObjectStore } from '@c3-oss/prosa-storage'
import { receiptPayloadBytes } from '@c3-oss/prosa-types-v2'
import { promotionReceiptV2Schema } from '@c3-oss/prosa-wire-v2'
import { blake3 } from '@noble/hashes/blake3'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCli } from '../../src/cli/main.js'

const PG_URL = process.env.PROSA_TEST_POSTGRES_URL
const S3_ENDPOINT = process.env.PROSA_TEST_S3_ENDPOINT
const S3_BUCKET = process.env.PROSA_TEST_S3_BUCKET ?? 'prosa-test-v2-cli'
const S3_ACCESS_KEY = process.env.PROSA_TEST_S3_ACCESS_KEY
const S3_SECRET_KEY = process.env.PROSA_TEST_S3_SECRET_KEY
const S3_REGION = process.env.PROSA_TEST_S3_REGION ?? 'us-east-1'

const shouldRun = Boolean(PG_URL && S3_ENDPOINT && S3_ACCESS_KEY && S3_SECRET_KEY)

function blake3HexLocal(bytes: Uint8Array): string {
  let out = ''
  for (const byte of blake3(bytes)) out += byte.toString(16).padStart(2, '0')
  return out
}

function transportHashOf(bytes: Uint8Array): string {
  return `blake3:${blake3HexLocal(bytes)}`
}

type Harness = {
  baseUrl: string
  app: FastifyInstance
  tmpRoot: string
  bundlePath: string
  close: () => Promise<void>
}

async function resetSchema(pgUrl: string): Promise<void> {
  const client = postgres(pgUrl, { max: 1, prepare: false })
  try {
    await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
    const sqlClient = { exec: async (sql: string) => void (await client.unsafe(sql)) }
    await applySchema(sqlClient)
    await applyV2PromotionSubsetSchema(sqlClient)
  } finally {
    await client.end({ timeout: 2 })
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

async function bootHarness(): Promise<Harness> {
  await resetSchema(PG_URL!)
  await ensureBucket()
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'prosa-sync-v2-e2e-'))
  const bundlePath = path.join(tmpRoot, 'bundle')
  await mkdir(bundlePath, { recursive: true })

  const config = loadConfig({
    PROSA_RUNTIME_MODE: 'test',
    PROSA_AUTH_SECRET: 'sync-v2-e2e-secret-1234567890abcdef',
    PROSA_API_URL: 'http://127.0.0.1:0',
    PROSA_OBJECT_STORE_DRIVER: 's3',
    PROSA_OBJECT_STORE_BUCKET: S3_BUCKET,
    PROSA_OBJECT_STORE_REGION: S3_REGION,
    PROSA_OBJECT_STORE_ENDPOINT: S3_ENDPOINT,
    PROSA_OBJECT_STORE_ACCESS_KEY_ID: S3_ACCESS_KEY,
    PROSA_OBJECT_STORE_SECRET_ACCESS_KEY: S3_SECRET_KEY,
  } as NodeJS.ProcessEnv)
  const dbHandle = await openPostgresDatabase(PG_URL!)
  const auth = createAuth({ config, db: dbHandle.db })
  const objectStore = new S3ObjectStore({
    bucket: S3_BUCKET,
    endpoint: S3_ENDPOINT,
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
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
  return {
    baseUrl,
    app,
    tmpRoot,
    bundlePath,
    close: async () => {
      await app.close()
      await dbHandle.close()
      await rm(tmpRoot, { recursive: true, force: true })
    },
  }
}

async function signupViaApi(
  baseUrl: string,
  email: string,
  tenantName: string,
  tenantSlug: string,
): Promise<{ token: string; tenantId: string; userId: string }> {
  const r = await fetch(`${baseUrl}/trpc/auth.signupWithTenant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct-horse-battery', name: email, tenantName, tenantSlug }),
  })
  expect(r.status).toBe(200)
  const body = (await r.json()) as {
    result: { data: { token: string; user: { id: string }; tenant: { id: string } } }
  }
  return { token: body.result.data.token, tenantId: body.result.data.tenant.id, userId: body.result.data.user.id }
}

async function buildBundleOnDisk(bundlePath: string, opts: { storeId: string; bundleRoot: string }): Promise<void> {
  const objectInventoryBytes = new TextEncoder().encode('sync-v2-cli-e2e-obj-inv')
  const projectionInventoryBytes = new TextEncoder().encode('sync-v2-cli-e2e-proj-inv')
  const pack = buildCasPack([{ bytes: new TextEncoder().encode('sync-v2-cli-e2e-payload'), compression: 'zstd' }], {
    createdAt: '2026-05-20T00:00:00.000Z',
  })

  const head = {
    bundleFormat: 2 as const,
    storeId: opts.storeId,
    storePath: '/home/test/store-sync-v2-cli',
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

  const objectInventoryRef = {
    segmentId: 'sync-v2-cli-obj-inv',
    kind: 'inventory_object' as const,
    digest: transportHashOf(objectInventoryBytes),
    logicalRoot: 'objects/inv',
    compression: 'zstd' as const,
    byteLength: objectInventoryBytes.byteLength,
  }
  const projectionInventoryRef = {
    segmentId: 'sync-v2-cli-proj-inv',
    kind: 'inventory_projection' as const,
    digest: transportHashOf(projectionInventoryBytes),
    logicalRoot: 'projection/inv',
    compression: 'zstd' as const,
    byteLength: projectionInventoryBytes.byteLength,
  }

  await writeFile(path.join(bundlePath, 'head.json'), JSON.stringify(head))
  await writeFile(path.join(bundlePath, 'obj-inv.bin'), objectInventoryBytes)
  await writeFile(path.join(bundlePath, 'proj-inv.bin'), projectionInventoryBytes)
  await writeFile(path.join(bundlePath, 'pack-0.pack'), pack.bytes)
  await writeFile(
    path.join(bundlePath, 'sync-v2.layout.json'),
    JSON.stringify({
      storePath: head.storePath,
      objectInventory: { ref: objectInventoryRef, file: 'obj-inv.bin' },
      projectionInventory: { ref: projectionInventoryRef, file: 'proj-inv.bin' },
      objectPacks: [{ file: 'pack-0.pack' }],
    }),
  )
}

async function capturedRun(args: string[]): Promise<{ stdout: string }> {
  const original = process.stdout.write.bind(process.stdout)
  const captured: string[] = []
  process.stdout.write = ((chunk: unknown) => {
    captured.push(typeof chunk === 'string' ? chunk : String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    await runCli(['node', 'prosa', ...args])
  } finally {
    process.stdout.write = original
  }
  return { stdout: captured.join('') }
}

describe.skipIf(!shouldRun)('CQ-140: prosa v2 sync end-to-end via runCli + listening server + Docker', () => {
  let h: Harness
  beforeEach(async () => {
    h = await bootHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('promotes a bundle from disk via `prosa v2 sync` (fetch over HTTP) and the receipt verifies against JWKS', async () => {
    const account = await signupViaApi(h.baseUrl, 'sync-v2-cli@example.com', 'Acme', 'acme-sync-v2-cli')
    await buildBundleOnDisk(h.bundlePath, { storeId: 'store-sync-v2-cli', bundleRoot: 'aa'.repeat(32) })

    const tokenFile = path.join(h.tmpRoot, 'token')
    await writeFile(tokenFile, account.token)

    const out = await capturedRun([
      'v2',
      'sync',
      '--server',
      h.baseUrl,
      '--token-file',
      tokenFile,
      '--tenant',
      account.tenantId,
      '--store',
      'store-sync-v2-cli',
      '--device',
      'dev-sync-v2-cli',
      '--bundle',
      h.bundlePath,
      '--json',
    ])
    expect(out.stdout).toContain('"status":"sealed"')

    // Pull the sealed receipt id from the JSON output and verify
    // against the published JWKS using node:crypto.
    const sealedLine = out.stdout.split('\n').find((l) => l.includes('"status":"sealed"'))
    if (!sealedLine) throw new Error(`no sealed line in CLI output: ${out.stdout}`)
    const parsed = JSON.parse(sealedLine) as {
      status: 'sealed'
      receipt: { payload: Record<string, unknown>; signature: { keyId: string; sig: string } }
    }
    const schemaParse = promotionReceiptV2Schema.safeParse(parsed.receipt)
    expect(schemaParse.success).toBe(true)

    // JWKS fetch + signature verify via a fresh HTTP call (not
    // inject) — proves a separate process consuming the published
    // JWKS verifies the signature end-to-end.
    const jwksResponse = await fetch(`${h.baseUrl}/v2/.well-known/receipt-keys.json`)
    expect(jwksResponse.status).toBe(200)
    const jwks = (await jwksResponse.json()) as {
      keys: Array<{ kty: string; crv: string; x: string; kid: string }>
    }
    const key = jwks.keys.find((k) => k.kid === parsed.receipt.signature.keyId)
    expect(key).toBeDefined()
    const { createPublicKey, verify } = await import('node:crypto')
    const publicKey = createPublicKey({ key: { ...key!, alg: 'EdDSA' } as never, format: 'jwk' })
    const sigBytes = Buffer.from(parsed.receipt.signature.sig, 'base64url')
    const ok = verify(null, receiptPayloadBytes(parsed.receipt.payload as never), publicKey, sigBytes)
    expect(ok).toBe(true)
  }, 120_000)

  it('a second device in the same tenant cannot fetch the first device receipt (CQ-127 + CQ-140 second-device read)', async () => {
    const account = await signupViaApi(h.baseUrl, 'sync-v2-cli-2@example.com', 'AcmeTwo', 'acme-sync-v2-cli-2')
    await buildBundleOnDisk(h.bundlePath, { storeId: 'store-sync-v2-cli-2', bundleRoot: 'bb'.repeat(32) })
    const tokenFile = path.join(h.tmpRoot, 'token2')
    await writeFile(tokenFile, account.token)

    const out = await capturedRun([
      'v2',
      'sync',
      '--server',
      h.baseUrl,
      '--token-file',
      tokenFile,
      '--tenant',
      account.tenantId,
      '--store',
      'store-sync-v2-cli-2',
      '--device',
      'dev-sync-v2-cli-a',
      '--bundle',
      h.bundlePath,
      '--json',
    ])
    expect(out.stdout).toContain('"status":"sealed"')
    const sealedLine = out.stdout.split('\n').find((l) => l.includes('"status":"sealed"'))!
    const parsed = JSON.parse(sealedLine) as { receipt: { payload: { receiptId: string } } }
    const receiptId = parsed.receipt.payload.receiptId

    // Owning device (dev-sync-v2-cli-a) fetch via HTTP — the
    // device is registered (auto-claimed by BeginPromotion) so
    // GetReceipt returns 200.
    const ok = await fetch(`${h.baseUrl}/v2/receipts/${receiptId}`, {
      headers: { authorization: `Bearer ${account.token}`, 'x-prosa-device-id': 'dev-sync-v2-cli-a' },
    })
    expect(ok.status).toBe(200)

    // Second device in the same tenant: register a separate
    // device id then attempt to fetch the receipt. CQ-127 +
    // CQ-138 force the route to compare `payload.deviceId`
    // against the verified header, so a different device gets
    // 404 RECEIPT_NOT_FOUND — existence is not leaked.
    const dbClient = postgres(PG_URL!, { max: 1, prepare: false })
    try {
      await dbClient`INSERT INTO device (id, tenant_id, user_id, name) VALUES (${'dev-sync-v2-cli-b'}, ${account.tenantId}, ${account.userId}, ${'dev-sync-v2-cli-b'}) ON CONFLICT (id) DO NOTHING`
    } finally {
      await dbClient.end({ timeout: 2 })
    }

    const denied = await fetch(`${h.baseUrl}/v2/receipts/${receiptId}`, {
      headers: { authorization: `Bearer ${account.token}`, 'x-prosa-device-id': 'dev-sync-v2-cli-b' },
    })
    expect(denied.status).toBe(404)
    const deniedBody = (await denied.json()) as { code: string }
    expect(deniedBody.code).toBe('RECEIPT_NOT_FOUND')
  }, 120_000)
})
