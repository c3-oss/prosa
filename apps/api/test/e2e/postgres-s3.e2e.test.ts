import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { applySchema } from '@c3-oss/prosa-db'
import { S3ObjectStore, computeHashHex } from '@c3-oss/prosa-storage'
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { compress as zstdCompress } from 'zstd-napi'
import { buildApp } from '../../src/app.js'
import { createAuth } from '../../src/auth.js'
import { loadConfig } from '../../src/config.js'
import { openPostgresDatabase } from '../../src/db.js'

const PG_URL = process.env.PROSA_TEST_POSTGRES_URL
const S3_ENDPOINT = process.env.PROSA_TEST_S3_ENDPOINT
const S3_BUCKET = process.env.PROSA_TEST_S3_BUCKET ?? 'prosa-test'
const S3_ACCESS_KEY = process.env.PROSA_TEST_S3_ACCESS_KEY
const S3_SECRET_KEY = process.env.PROSA_TEST_S3_SECRET_KEY
const S3_REGION = process.env.PROSA_TEST_S3_REGION ?? 'us-east-1'

const shouldRun = Boolean(PG_URL && S3_ENDPOINT && S3_ACCESS_KEY && S3_SECRET_KEY)

describe.skipIf(!shouldRun)('e2e: prosa-api against real Postgres + S3 (MinIO)', () => {
  it('runs the full signup → handshake → upload → commit → verify path', async () => {
    if (!PG_URL || !S3_ENDPOINT || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
      throw new Error('e2e env vars missing — should be skipped')
    }

    // Bring up schema in the real Postgres database.
    const bootstrapClient = postgres(PG_URL, { max: 1, prepare: false })
    await bootstrapClient.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
    await applySchema({
      exec: async (sql) => {
        await bootstrapClient.unsafe(sql)
      },
    })
    await bootstrapClient.end({ timeout: 2 })

    // Ensure bucket exists in MinIO.
    const s3 = new S3Client({
      endpoint: S3_ENDPOINT,
      region: S3_REGION,
      credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
      forcePathStyle: true,
    })
    try {
      await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }))
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }))
    }

    const config = loadConfig({
      // CQ-140: the v2 plugin requires either a configured signer
      // or runtimeMode != production. The v1 e2e doesn't carry a
      // signer, so we run it in test mode so the in-process Ed25519
      // signer is acceptable and `MissingV2SignerError` doesn't
      // fire on boot.
      PROSA_RUNTIME_MODE: 'test',
      PROSA_DATABASE_URL: PG_URL,
      PROSA_AUTH_SECRET: 'e2e-secret-1234567890abcdef',
      PROSA_API_URL: 'http://127.0.0.1:3000',
      PROSA_OBJECT_STORE_DRIVER: 's3',
      PROSA_OBJECT_STORE_BUCKET: S3_BUCKET,
      PROSA_OBJECT_STORE_REGION: S3_REGION,
      PROSA_OBJECT_STORE_ENDPOINT: S3_ENDPOINT,
      PROSA_OBJECT_STORE_ACCESS_KEY_ID: S3_ACCESS_KEY,
      PROSA_OBJECT_STORE_SECRET_ACCESS_KEY: S3_SECRET_KEY,
    } as NodeJS.ProcessEnv)

    const dbHandle = await openPostgresDatabase(PG_URL)
    const auth = createAuth({ config, db: dbHandle.db })
    const objectStore = new S3ObjectStore({
      bucket: S3_BUCKET,
      endpoint: S3_ENDPOINT,
      region: S3_REGION,
      accessKeyId: S3_ACCESS_KEY,
      secretAccessKey: S3_SECRET_KEY,
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

    try {
      const signup = await app.inject({
        method: 'POST',
        url: '/trpc/auth.signupWithTenant',
        headers: { 'content-type': 'application/json' },
        payload: {
          email: 'e2e@example.com',
          password: 'correct-horse-battery',
          name: 'E2E',
          tenantName: 'E2E Co',
          tenantSlug: 'e2e-co',
        } as never,
      })
      expect(signup.statusCode).toBe(200)
      const token = (signup.json() as { result: { data: { token: string } } }).result.data.token

      const hs = await app.inject({
        method: 'POST',
        url: '/trpc/sync.handshake',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        payload: {
          cliVersion: '0.0.0',
          device: { name: 'e2e' },
          store: { path: '/tmp/.prosa-e2e', bundleVersion: '1' },
        } as never,
      })
      const deviceId = (hs.json() as { result: { data: { deviceId: string } } }).result.data.deviceId

      const e2eBytes = new Uint8Array([1, 2, 3, 4, 5])
      const e2eTransportBytes = zstdCompress(e2eBytes)
      const e2eHash = computeHashHex(e2eBytes, 'blake3')
      const e2eTransportHash = computeHashHex(e2eTransportBytes, 'blake3')
      const e2eObjectId = `blake3:${e2eHash}`
      const plan = await app.inject({
        method: 'POST',
        url: '/trpc/sync.planUpload',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        payload: {
          deviceId,
          storePath: '/tmp/.prosa-e2e',
          objects: [
            {
              objectId: e2eObjectId,
              hash: e2eHash,
              hashAlgorithm: 'blake3',
              uncompressedSize: 5,
              compressedSize: e2eTransportBytes.byteLength,
              compression: 'zstd',
              transportHash: e2eTransportHash,
            },
          ],
        } as never,
      })
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId

      const putResp = await app.inject({
        method: 'PUT',
        url:
          `/objects/${e2eObjectId}?batchId=${batchId}&hash=${e2eHash}&size=${e2eTransportBytes.byteLength}` +
          `&uncompressed=5&compression=zstd&transportHash=${e2eTransportHash}`,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/octet-stream',
        },
        payload: e2eTransportBytes,
      })
      expect([200, 201]).toContain(putResp.statusCode)

      const commit = await app.inject({
        method: 'POST',
        url: '/trpc/sync.commitUpload',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        payload: {
          batchId,
          deviceId,
          storePath: '/tmp/.prosa-e2e',
          objects: [
            {
              objectId: e2eObjectId,
              hash: e2eHash,
              hashAlgorithm: 'blake3',
              uncompressedSize: 5,
              compressedSize: e2eTransportBytes.byteLength,
              compression: 'zstd',
              transportHash: e2eTransportHash,
            },
          ],
          projection: {
            sessions: [{ id: 'sess-e2e-1', sourceKind: 'codex', title: 'e2e', turnCount: 1 }],
            searchDocs: [{ id: 'doc-e2e-1', sessionId: 'sess-e2e-1', kind: 'session', body: 'real db' }],
          },
        } as never,
      })
      expect(commit.statusCode).toBe(200)

      const verify = await app.inject({
        method: 'POST',
        url: '/trpc/sync.verifyPromotion',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        payload: {
          batchId,
          storePath: '/tmp/.prosa-e2e',
          declaredObjectIds: [e2eObjectId],
          declaredSessionIds: ['sess-e2e-1'],
          declaredSearchDocIds: ['doc-e2e-1'],
        } as never,
      })
      const receipt = (
        verify.json() as {
          result: {
            data: { receipt: { sessionCount: number; objectCount: number; searchDocCount: number } }
          }
        }
      ).result.data.receipt
      expect(receipt.sessionCount).toBe(1)
      expect(receipt.objectCount).toBe(1)
      expect(receipt.searchDocCount).toBe(1)

      // Confirm the bytes really live in MinIO.
      const stored = await objectStore.head(
        `objects/blake3/${e2eHash.slice(0, 2)}/${e2eHash.slice(2, 4)}/${e2eHash}.zst`,
      )
      expect(stored).not.toBeNull()
      expect(stored?.hash).toBe(e2eTransportHash)
      expect(stored?.compressedSize).toBe(e2eTransportBytes.byteLength)
      expect(stored?.uncompressedSize).toBe(5)
    } finally {
      await app.close()
      await dbHandle.close()
    }
  }, 60_000)
})
