import { Readable } from 'node:stream'
import { ObjectVerificationError, type PutResult, type RemoteObjectStore, computeHashHex } from '@c3-oss/prosa-storage'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { DecompressStream } from 'zstd-napi'
import type { ProsaAuth } from '../auth.js'
import type { RawExec } from '../db.js'
import { resolveMembership } from '../trpc/context.js'

export type ObjectRoutesDeps = {
  auth: ProsaAuth
  rawExec: RawExec
  objectStore: RemoteObjectStore
  maxObjectBytes?: number
}

function fastifyHeadersToHeaders(req: FastifyRequest): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, String(v))
    } else {
      headers.set(key, String(value))
    }
  }
  return headers
}

function readFirstHeader(req: FastifyRequest, name: string): string | null {
  const value = req.headers[name]
  if (Array.isArray(value)) return value[0] ?? null
  return typeof value === 'string' ? value : null
}

async function resolveAuth(opts: ObjectRoutesDeps, req: FastifyRequest) {
  const headers = fastifyHeadersToHeaders(req)
  const result = (await opts.auth.api.getSession({ headers })) as {
    session: { id: string; userId: string; activeOrganizationId?: string | null }
    user: { id: string; email: string }
  } | null
  if (!result) return null
  // Tenant resolution must verify membership against the `member` table, just
  // like the tRPC context. Trusting `x-prosa-tenant-id` directly would let a
  // signed-in user spoof another tenant's objects.
  const candidate = readFirstHeader(req, 'x-prosa-tenant-id') ?? result.session.activeOrganizationId ?? null
  if (!candidate) {
    return { user: result.user, session: result.session, tenantId: null }
  }
  const role = await resolveMembership({
    rawExec: opts.rawExec,
    tenantId: candidate,
    userId: result.user.id,
  })
  if (!role) {
    return { user: result.user, session: result.session, tenantId: null }
  }
  return { user: result.user, session: result.session, tenantId: candidate }
}

const BLAKE3_HEX_RE = /^[0-9a-f]{64}$/i
export const DEFAULT_OBJECT_ROUTE_MAX_BYTES = 256 * 1024 * 1024

type AuthContext = NonNullable<Awaited<ReturnType<typeof resolveAuth>>>
type ObjectCompression = 'zstd' | 'none'

type UploadRequest = {
  objectId: string
  batchId: string
  hash: string
  transportHash: string
  compression: ObjectCompression
  compressedSize: number
  uncompressedSize: number
  storageKey: string
}

type BatchManifestRow = {
  canonical_hash: string
  transport_hash: string
  compression: string
  uncompressed_size: string | number
  compressed_size: string | number
}

type RemoteObjectRow = {
  hash: string
  hash_algorithm: string
  compression: string
  uncompressed_size: string | number
  compressed_size: string | number
  storage_key: string
}

type AccessibleObjectRow = RemoteObjectRow & {
  tenant: string | null
}

class ObjectRouteError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

function fail(statusCode: number, message: string): never {
  throw new ObjectRouteError(statusCode, message)
}

function sendObjectRouteError(reply: FastifyReply, err: unknown): { error: string } {
  if (err instanceof ObjectRouteError) {
    reply.code(err.statusCode)
    return { error: err.message }
  }
  throw err
}

function canonicalObjectId(hash: string): string {
  return `blake3:${hash.toLowerCase()}`
}

function objectStorageKey(hash: string, compression: ObjectCompression): string {
  const ext = compression === 'zstd' ? '.zst' : '.bin'
  return `objects/blake3/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}${ext}`
}

function parseSizeParam(value: string | null, name: string, maxObjectBytes: number): number {
  if (value == null || value.trim() === '') {
    fail(400, `${name} query parameter required`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail(400, `${name} must be a nonnegative safe integer`)
  }
  if (parsed > maxObjectBytes) {
    fail(400, `${name} exceeds maxObjectBytes`)
  }
  return parsed
}

function parseCompression(value: string | null): ObjectCompression {
  const compression = value ?? 'zstd'
  if (compression !== 'zstd' && compression !== 'none') {
    fail(400, 'compression must be zstd or none')
  }
  return compression
}

function parseUploadRequest(req: FastifyRequest, maxObjectBytes: number): UploadRequest {
  const { objectId } = req.params as { objectId: string }
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const hash = url.searchParams.get('hash')?.toLowerCase()
  const batchId = url.searchParams.get('batchId')
  if (!batchId) {
    fail(400, 'batchId query parameter required')
  }
  const compressedSize = parseSizeParam(url.searchParams.get('size'), 'size', maxObjectBytes)
  const uncompressedSize = parseSizeParam(url.searchParams.get('uncompressed'), 'uncompressed', maxObjectBytes)
  if (!hash || !BLAKE3_HEX_RE.test(hash)) {
    fail(400, 'valid blake3 hash query parameter required')
  }
  if (objectId !== canonicalObjectId(hash)) {
    fail(400, 'objectId must be blake3:<hash>')
  }
  const compression = parseCompression(url.searchParams.get('compression'))
  const transportHash = (url.searchParams.get('transportHash') ?? hash).toLowerCase()
  if (!BLAKE3_HEX_RE.test(transportHash)) {
    fail(400, 'valid transportHash required')
  }

  return {
    objectId,
    batchId,
    hash,
    transportHash,
    compression,
    compressedSize,
    uncompressedSize,
    storageKey: objectStorageKey(hash, compression),
  }
}

async function decompressBody(
  body: Buffer,
  compression: ObjectCompression,
  expectedUncompressedSize: number,
  maxObjectBytes: number,
): Promise<Buffer> {
  if (compression === 'none') return body
  const chunks: Buffer[] = []
  let total = 0
  const decompressed = Readable.from([body]).pipe(new DecompressStream())
  for await (const chunk of decompressed) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > expectedUncompressedSize || total > maxObjectBytes) {
      decompressed.destroy()
      throw new Error('decompressed object exceeds declared size')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, total)
}

function requireBinaryBody(body: unknown): Buffer {
  if (!Buffer.isBuffer(body)) {
    fail(400, 'binary body required (use application/octet-stream)')
  }
  return body
}

async function verifyUploadBody(body: Buffer, upload: UploadRequest, maxObjectBytes: number): Promise<void> {
  if (body.byteLength !== upload.compressedSize) {
    fail(400, `size mismatch: header declared ${upload.compressedSize}, body has ${body.byteLength}`)
  }

  const computedTransportHash = computeHashHex(body, 'blake3')
  if (computedTransportHash !== upload.transportHash) {
    fail(400, `transport hash mismatch: declared ${upload.transportHash}, computed ${computedTransportHash}`)
  }

  let plain: Buffer
  try {
    plain = await decompressBody(body, upload.compression, upload.uncompressedSize, maxObjectBytes)
  } catch {
    fail(400, 'unable to decompress object body')
  }
  if (plain.byteLength !== upload.uncompressedSize) {
    fail(400, `uncompressed size mismatch: declared ${upload.uncompressedSize}, body has ${plain.byteLength}`)
  }

  const computedCanonicalHash = computeHashHex(plain, 'blake3')
  if (computedCanonicalHash !== upload.hash) {
    fail(400, `canonical hash mismatch: declared ${upload.hash}, computed ${computedCanonicalHash}`)
  }
}

function manifestMatches(declared: BatchManifestRow, upload: UploadRequest): boolean {
  return (
    declared.canonical_hash.toLowerCase() === upload.hash &&
    declared.transport_hash.toLowerCase() === upload.transportHash &&
    declared.compression === upload.compression &&
    Number(declared.uncompressed_size) === upload.uncompressedSize &&
    Number(declared.compressed_size) === upload.compressedSize
  )
}

async function assertDeclaredByOpenBatch(
  deps: ObjectRoutesDeps,
  ctx: AuthContext,
  upload: UploadRequest,
): Promise<void> {
  const declaredRows = await deps.rawExec<BatchManifestRow>(
    `SELECT m.canonical_hash, m.transport_hash, m.compression, m.uncompressed_size, m.compressed_size
       FROM "sync_batch_object_manifest" m
       JOIN "sync_batch" b
         ON b.id = m.batch_id
        AND b.tenant_id = m.tenant_id
        AND b.status = 'open'
        AND b.user_id = $3
      WHERE m.batch_id = $1
        AND m.tenant_id = $2
        AND m.object_id = $4
      LIMIT 1`,
    [upload.batchId, ctx.tenantId, ctx.user.id, upload.objectId],
  )
  const declared = declaredRows[0]
  if (!declared) {
    fail(403, 'object is not declared by an open sync batch for this tenant')
  }
  if (!manifestMatches(declared, upload)) {
    fail(409, 'object upload metadata does not match the planned batch manifest')
  }
}

function catalogMatches(existing: RemoteObjectRow, upload: UploadRequest): boolean {
  return (
    existing.hash.toLowerCase() === upload.hash &&
    existing.hash_algorithm === 'blake3' &&
    existing.compression === upload.compression &&
    Number(existing.uncompressed_size) === upload.uncompressedSize &&
    Number(existing.compressed_size) === upload.compressedSize &&
    existing.storage_key === upload.storageKey
  )
}

async function assertCatalogCompatible(deps: ObjectRoutesDeps, upload: UploadRequest): Promise<void> {
  const existingRows = await deps.rawExec<RemoteObjectRow>(
    `SELECT hash, hash_algorithm, compression, uncompressed_size, compressed_size, storage_key
       FROM "remote_object" WHERE object_id = $1 LIMIT 1`,
    [upload.objectId],
  )
  const existing = existingRows[0]
  if (existing && !catalogMatches(existing, upload)) {
    fail(409, 'conflicting remote object metadata')
  }
}

async function* bufferAsAsyncIterable(body: Buffer): AsyncIterable<Uint8Array> {
  yield new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
}

async function putObjectBytes(deps: ObjectRoutesDeps, upload: UploadRequest, body: Buffer): Promise<PutResult> {
  try {
    return await deps.objectStore.putIfAbsent(upload.storageKey, bufferAsAsyncIterable(body), {
      hash: upload.transportHash,
      hashAlgorithm: 'blake3',
      uncompressedSize: upload.uncompressedSize,
      compressedSize: upload.compressedSize,
    })
  } catch (err) {
    if (err instanceof ObjectVerificationError) {
      fail(409, err.message)
    }
    throw err
  }
}

async function insertRemoteObjectCatalog(deps: ObjectRoutesDeps, upload: UploadRequest): Promise<void> {
  await deps.rawExec(
    `INSERT INTO "remote_object"(object_id, hash, hash_algorithm, compression, uncompressed_size, compressed_size, storage_key)
     VALUES ($1, $2, 'blake3', $3, $4, $5, $6)
     ON CONFLICT (object_id) DO NOTHING`,
    [
      upload.objectId,
      upload.hash,
      upload.compression,
      upload.uncompressedSize,
      upload.compressedSize,
      upload.storageKey,
    ],
  )
}

async function recordObjectUpload(deps: ObjectRoutesDeps, upload: UploadRequest, put: PutResult): Promise<void> {
  try {
    await insertRemoteObjectCatalog(deps, upload)
  } catch (err) {
    // Catalog insert failed after a successful upload. If this PUT wrote new
    // bytes (rather than no-oping on a pre-existing object), best-effort
    // delete those bytes so we don't leak storage. putIfAbsent is content-
    // addressed and idempotent, so a client retry of the PUT will re-upload
    // and re-attempt the catalog insert without data loss.
    if (!put.alreadyExisted) {
      try {
        await deps.objectStore.delete(upload.storageKey)
      } catch {
        // Swallow: cleanup is best-effort. A residual orphan blob is then a
        // storage-accounting issue, not a correctness one; reads against
        // `object_id` without a catalog row return 404.
      }
    }
    throw err
  }
}

async function findAccessibleObject(
  deps: ObjectRoutesDeps,
  objectId: string,
  tenantId: string,
): Promise<AccessibleObjectRow | null> {
  const rows = await deps.rawExec<AccessibleObjectRow>(
    `SELECT ro.hash, ro.hash_algorithm, ro.compression, ro.uncompressed_size,
            ro.compressed_size, ro.storage_key, MAX(to_.tenant_id) AS tenant
       FROM "remote_object" ro
       LEFT JOIN "tenant_object" to_ ON to_.object_id = ro.object_id AND to_.tenant_id = $2
       WHERE ro.object_id = $1
       GROUP BY ro.hash, ro.hash_algorithm, ro.compression, ro.uncompressed_size,
                ro.compressed_size, ro.storage_key`,
    [objectId, tenantId],
  )
  return rows[0] ?? null
}

function sendObjectStream(reply: FastifyReply, row: AccessibleObjectRow, stream: ReadableStream<Uint8Array>) {
  reply.header('content-type', 'application/octet-stream')
  reply.header('content-length', String(row.compressed_size))
  reply.header('cache-control', 'no-store')
  reply.header('x-prosa-hash-algorithm', row.hash_algorithm)
  reply.header('x-prosa-canonical-hash', row.hash)
  reply.header('x-prosa-compression', row.compression)
  reply.header('x-prosa-uncompressed-size', String(row.uncompressed_size))
  return reply.send(Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]))
}

export async function registerObjectRoutes(app: FastifyInstance, deps: ObjectRoutesDeps) {
  const maxObjectBytes = deps.maxObjectBytes ?? DEFAULT_OBJECT_ROUTE_MAX_BYTES
  // Enable raw body parsing for octet-stream so PUT bodies pass through unmodified.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: maxObjectBytes },
    (_req, body, done) => {
      done(null, body)
    },
  )

  app.route({
    method: 'PUT',
    url: '/objects/:objectId',
    bodyLimit: maxObjectBytes,
    config: { rawBody: true },
    handler: async (request, reply) => {
      const ctx = await resolveAuth(deps, request)
      if (!ctx) {
        reply.code(401)
        return { error: 'unauthorized' }
      }
      if (!ctx.tenantId) {
        reply.code(403)
        return { error: 'not a member of the requested tenant' }
      }
      try {
        const upload = parseUploadRequest(request, maxObjectBytes)
        await assertDeclaredByOpenBatch(deps, ctx, upload)
        const body = requireBinaryBody(request.body)
        await verifyUploadBody(body, upload, maxObjectBytes)
        await assertCatalogCompatible(deps, upload)
        const put = await putObjectBytes(deps, upload, body)
        await recordObjectUpload(deps, upload, put)

        reply.code(put.alreadyExisted ? 200 : 201)
        // CQ-008: only return public identifiers — never the raw storage key.
        return {
          objectId: upload.objectId,
          alreadyExisted: put.alreadyExisted,
        }
      } catch (err) {
        return sendObjectRouteError(reply, err)
      }
    },
  })

  app.route({
    method: 'GET',
    url: '/objects/:objectId',
    handler: async (request, reply) => {
      const ctx = await resolveAuth(deps, request)
      if (!ctx) {
        reply.code(401)
        return { error: 'unauthorized' }
      }
      if (!ctx.tenantId) {
        reply.code(403)
        return { error: 'not a member of the requested tenant' }
      }
      const { objectId } = request.params as { objectId: string }
      const row = await findAccessibleObject(deps, objectId, ctx.tenantId)
      if (!row) {
        reply.code(404)
        return { error: 'not found' }
      }
      if (!row.tenant) {
        reply.code(403)
        return { error: 'tenant has no access to this object' }
      }
      const stream = await deps.objectStore.get(row.storage_key)
      return sendObjectStream(reply, row, stream)
    },
  })
}
