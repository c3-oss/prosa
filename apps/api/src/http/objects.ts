import { Readable } from 'node:stream'
import {
  BLAKE3_HEX_RE,
  type ObjectCompression,
  ObjectVerificationError,
  type PutResult,
  type RemoteObjectStore,
  canonicalObjectId,
  computeHashHex,
  objectPackStorageKey,
  objectStorageKey,
  putPreverifiedIfAbsent,
} from '@c3-oss/prosa-storage'
import {
  BinaryObjectPackFormatError,
  OBJECT_PACK_BINARY_CONTENT_TYPE,
  type ObjectPackWireEntry,
  decodeBinaryObjectPack,
} from '@c3-oss/prosa-sync'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { DecompressStream } from 'zstd-napi'
import type { ProsaAuth } from '../auth.js'
import type { DatabaseHandle, RawExec } from '../db.js'
import { hasCompatibleObjectBytes, readObjectByteLocation, resolveObjectByteLocation } from '../objects/locations.js'
import { type BatchManifestRow, loadBatchManifest } from '../objects/manifest-cache.js'
import { readFirstHeader, requestToHeaders } from '../shared/http.js'
import { resolveMembership } from '../trpc/context.js'

export type ObjectRoutesDeps = {
  auth: ProsaAuth
  rawExec: RawExec
  transaction?: DatabaseHandle['transaction']
  objectStore: RemoteObjectStore
  maxObjectBytes?: number
}

async function resolveAuth(opts: ObjectRoutesDeps, req: FastifyRequest) {
  const headers = requestToHeaders(req)
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

export const DEFAULT_OBJECT_ROUTE_MAX_BYTES = 256 * 1024 * 1024
const MAX_OBJECT_PACK_ENTRIES = 1024
const MAX_OBJECT_PACK_BINARY_HEADER_BYTES = 1024 * 1024

type AuthContext = NonNullable<Awaited<ReturnType<typeof resolveAuth>>>

type UploadRequest = {
  objectId: string
  batchId: string
  hash: string
  transportHash: string
  compression: ObjectCompression
  compressedSize: number
  uncompressedSize: number
  storageKey: string
  contentType?: string
}

type RemoteObjectRow = {
  hash: string
  hash_algorithm: string
  compression: string
  uncompressed_size: string | number
  compressed_size: string | number
  storage_key: string | null
}

type AccessibleObjectRow = RemoteObjectRow & {
  tenant: string | null
}

type ObjectPackEntry = Omit<UploadRequest, 'batchId' | 'storageKey'> & {
  offset: number
  length: number
  contentType?: string
}

type ParsedObjectPack = {
  batchId: string
  entries: Array<ObjectPackEntry & { batchId: string; storageKey: string }>
  bytes: Buffer
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
    storageKey: objectStorageKey({ hash, compression }),
  }
}

function parseObjectPackRequest(req: FastifyRequest, maxObjectBytes: number): ParsedObjectPack {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const batchId = url.searchParams.get('batchId')
  if (!batchId) fail(400, 'batchId query parameter required')
  const body = req.body

  if (Buffer.isBuffer(body)) {
    let decoded: { entries: ObjectPackWireEntry[]; payload: Uint8Array }
    try {
      decoded = decodeBinaryObjectPack(body, { maxHeaderBytes: MAX_OBJECT_PACK_BINARY_HEADER_BYTES })
    } catch (err) {
      if (err instanceof BinaryObjectPackFormatError) {
        fail(400, err.message)
      }
      throw err
    }
    return parseObjectPackPayload(batchId, decoded.entries, bufferView(decoded.payload), maxObjectBytes)
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail(400, 'JSON body required')
  }
  const payload = body as Record<string, unknown>
  if (typeof payload.bytesBase64 !== 'string') {
    fail(400, 'bytesBase64 is required')
  }
  const bytes = Buffer.from(payload.bytesBase64, 'base64')
  return parseObjectPackPayload(batchId, payload.entries, bytes, maxObjectBytes)
}

function bufferView(bytes: Uint8Array): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function parseObjectPackPayload(
  batchId: string,
  rawEntries: unknown,
  bytes: Buffer,
  maxObjectBytes: number,
): ParsedObjectPack {
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    fail(400, 'entries must be a non-empty array')
  }
  if (rawEntries.length > MAX_OBJECT_PACK_ENTRIES) {
    fail(400, 'entries exceeds max object manifest count')
  }
  if (bytes.byteLength > maxObjectBytes) {
    fail(400, 'pack exceeds maxObjectBytes')
  }
  const entries = rawEntries.map((entry) => parseObjectPackEntry(entry, batchId, bytes.byteLength, maxObjectBytes))
  assertUniquePackObjectIds(entries)
  const aggregateCompressedSize = entries.reduce((sum, entry) => sum + entry.compressedSize, 0)
  const aggregateUncompressedSize = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
  if (aggregateCompressedSize > maxObjectBytes) {
    fail(400, 'pack aggregate compressed size exceeds maxObjectBytes')
  }
  if (aggregateUncompressedSize > maxObjectBytes) {
    fail(400, 'pack aggregate uncompressed size exceeds maxObjectBytes')
  }
  return { batchId, entries, bytes }
}

function parseObjectPackEntry(
  entry: unknown,
  batchId: string,
  packSize: number,
  maxObjectBytes: number,
): ParsedObjectPack['entries'][number] {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(400, 'pack entry must be an object')
  const value = entry as Record<string, unknown>
  const hash = typeof value.hash === 'string' ? value.hash.toLowerCase() : null
  if (!hash || !BLAKE3_HEX_RE.test(hash)) fail(400, 'valid blake3 hash required for every pack entry')
  const objectId = typeof value.objectId === 'string' ? value.objectId.toLowerCase() : ''
  if (objectId !== canonicalObjectId(hash)) fail(400, 'pack entry objectId must be blake3:<hash>')
  const compression = parseCompression(typeof value.compression === 'string' ? value.compression : null)
  const transportHash =
    typeof value.transportHash === 'string' && value.transportHash.length > 0 ? value.transportHash.toLowerCase() : hash
  if (!BLAKE3_HEX_RE.test(transportHash)) fail(400, 'valid transportHash required for every pack entry')
  const compressedSize = parseEntrySize(value.compressedSize, 'compressedSize', maxObjectBytes)
  const uncompressedSize = parseEntrySize(value.uncompressedSize, 'uncompressedSize', maxObjectBytes)
  const offset = parseEntrySize(value.offset, 'offset', maxObjectBytes)
  const length = parseEntrySize(value.length, 'length', maxObjectBytes)
  if (length !== compressedSize) fail(400, 'pack entry length must match compressedSize')
  if (offset + length > packSize) fail(400, 'pack entry range exceeds pack bytes')
  return {
    objectId,
    batchId,
    hash,
    transportHash,
    compression,
    compressedSize,
    uncompressedSize,
    storageKey: objectStorageKey({ hash, compression }),
    offset,
    length,
    ...(typeof value.contentType === 'string' ? { contentType: value.contentType } : {}),
  }
}

function assertUniquePackObjectIds(entries: ParsedObjectPack['entries']): void {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.objectId)) {
      fail(400, 'duplicate objectId in pack entries')
    }
    seen.add(entry.objectId)
  }
}

function parseEntrySize(value: unknown, name: string, maxObjectBytes: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(400, `${name} must be a nonnegative safe integer`)
  }
  if (value > maxObjectBytes) {
    fail(400, `${name} exceeds maxObjectBytes`)
  }
  return value
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

function assertTransportShape(body: Buffer, upload: UploadRequest): void {
  if (body.byteLength !== upload.compressedSize) {
    fail(400, `size mismatch: header declared ${upload.compressedSize}, body has ${body.byteLength}`)
  }
  const computed = computeHashHex(body, 'blake3')
  if (computed !== upload.transportHash) {
    fail(400, `transport hash mismatch: declared ${upload.transportHash}, computed ${computed}`)
  }
}

async function decodeUploadPayload(body: Buffer, upload: UploadRequest, maxObjectBytes: number): Promise<Buffer> {
  try {
    return await decompressBody(body, upload.compression, upload.uncompressedSize, maxObjectBytes)
  } catch {
    fail(400, 'unable to decompress object body')
  }
}

function assertCanonicalShape(plain: Buffer, upload: UploadRequest): void {
  if (plain.byteLength !== upload.uncompressedSize) {
    fail(400, `uncompressed size mismatch: declared ${upload.uncompressedSize}, body has ${plain.byteLength}`)
  }
  const computed = computeHashHex(plain, 'blake3')
  if (computed !== upload.hash) {
    fail(400, `canonical hash mismatch: declared ${upload.hash}, computed ${computed}`)
  }
}

async function verifyUploadBody(body: Buffer, upload: UploadRequest, maxObjectBytes: number): Promise<void> {
  assertTransportShape(body, upload)
  const plain = await decodeUploadPayload(body, upload, maxObjectBytes)
  assertCanonicalShape(plain, upload)
}

async function verifyPackBody(pack: ParsedObjectPack, maxObjectBytes: number): Promise<void> {
  assertNonOverlappingRanges(pack.entries)
  for (const entry of pack.entries) {
    const slice = pack.bytes.subarray(entry.offset, entry.offset + entry.length)
    await verifyUploadBody(slice, entry, maxObjectBytes)
  }
}

function assertNonOverlappingRanges(entries: ObjectPackEntry[]): void {
  const ranges = entries
    .map((entry) => ({ start: entry.offset, end: entry.offset + entry.length, objectId: entry.objectId }))
    .sort((a, b) => a.start - b.start)
  for (let i = 1; i < ranges.length; i += 1) {
    const previous = ranges[i - 1]
    const current = ranges[i]
    if (previous && current && current.start < previous.end) {
      fail(400, `pack entry range overlaps for ${current.objectId}`)
    }
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
  const manifest = await loadBatchManifest({
    rawExec: deps.rawExec,
    // ctx.tenantId is guarded as non-null by the caller before reaching here
    tenantId: ctx.tenantId as string,
    batchId: upload.batchId,
    userId: ctx.user.id,
  })
  const declared = manifest.get(upload.objectId)
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
    (existing.storage_key == null || existing.storage_key === upload.storageKey)
  )
}

async function assertCatalogCompatibleByExec(rawExec: RawExec, upload: UploadRequest): Promise<void> {
  const existingRows = await rawExec<RemoteObjectRow>(
    `SELECT hash, hash_algorithm, compression, uncompressed_size, compressed_size, storage_key
       FROM "remote_object" WHERE object_id = $1 LIMIT 1`,
    [upload.objectId],
  )
  const existing = existingRows[0]
  if (existing && !catalogMatches(existing, upload)) {
    fail(409, 'conflicting remote object metadata')
  }
}

async function assertCatalogCompatible(deps: ObjectRoutesDeps, upload: UploadRequest): Promise<void> {
  await assertCatalogCompatibleByExec(deps.rawExec, upload)
}

async function* bufferAsAsyncIterable(body: Buffer): AsyncIterable<Uint8Array> {
  yield new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
}

async function putObjectBytes(deps: ObjectRoutesDeps, upload: UploadRequest, body: Buffer): Promise<PutResult> {
  try {
    return await putPreverifiedIfAbsent(deps.objectStore, upload.storageKey, bufferAsAsyncIterable(body), {
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

async function insertRemoteObjectCatalog(rawExec: RawExec, ctx: AuthContext, upload: UploadRequest): Promise<void> {
  await rawExec(
    `INSERT INTO "remote_object"(object_id, hash, hash_algorithm, compression, uncompressed_size, compressed_size, storage_key, content_type)
     VALUES ($1, $2, 'blake3', $3, $4, $5, $6, $7)
     ON CONFLICT (object_id) DO NOTHING`,
    [
      upload.objectId,
      upload.hash,
      upload.compression,
      upload.uncompressedSize,
      upload.compressedSize,
      upload.storageKey,
      upload.contentType ?? null,
    ],
  )
  await assertCatalogCompatibleByExec(rawExec, upload)
  await rawExec(
    `INSERT INTO "remote_object_location"(tenant_id, object_id, batch_id, location_type, storage_key, byte_offset, byte_length)
     VALUES ($1, $2, $3, 'object', $4, 0, $5)
     ON CONFLICT (tenant_id, object_id) DO NOTHING`,
    [ctx.tenantId, upload.objectId, upload.batchId, upload.storageKey, upload.compressedSize],
  )
  await assertObjectLocationCompatible(rawExec, ctx, upload)
}

async function assertObjectLocationCompatible(
  rawExec: RawExec,
  ctx: AuthContext,
  upload: UploadRequest,
): Promise<void> {
  const rows = await rawExec<{
    location_type: string
    storage_key: string | null
    byte_offset: string | number
    byte_length: string | number
  }>(
    `SELECT location_type, storage_key, byte_offset, byte_length
       FROM "remote_object_location"
      WHERE tenant_id = $1 AND object_id = $2
      LIMIT 1`,
    [ctx.tenantId, upload.objectId],
  )
  const row = rows[0]
  if (!row) fail(500, 'object location insert failed')
  if (
    row.location_type !== 'object' ||
    row.storage_key !== upload.storageKey ||
    Number(row.byte_offset) !== 0 ||
    Number(row.byte_length) !== upload.compressedSize
  ) {
    fail(409, 'conflicting remote object location')
  }
}

async function insertTenantObjectProof(rawExec: RawExec, ctx: AuthContext, upload: UploadRequest): Promise<void> {
  await rawExec(
    `INSERT INTO "tenant_object"(tenant_id, object_id, first_batch_id, ref_count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (tenant_id, object_id) DO NOTHING`,
    [ctx.tenantId, upload.objectId, upload.batchId],
  )
}

async function recordObjectUpload(
  deps: ObjectRoutesDeps,
  ctx: AuthContext,
  upload: UploadRequest,
  put: PutResult,
): Promise<void> {
  try {
    await runObjectRouteTransaction(deps, async (tx) => {
      await insertRemoteObjectCatalog(tx, ctx, upload)
      await insertTenantObjectProof(tx, ctx, upload)
    })
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

async function putPackBytes(
  deps: ObjectRoutesDeps,
  ctx: AuthContext,
  pack: ParsedObjectPack,
): Promise<{
  blobId: string
  packHash: string
  packStorageKey: string
  put: PutResult
}> {
  const tenantId = ctx.tenantId
  if (!tenantId) fail(403, 'not a member of the requested tenant')
  const packHash = computeHashHex(pack.bytes, 'blake3')
  const packStorageKey = objectPackStorageKey({ tenantId, batchId: pack.batchId, packHash })
  const put = await deps.objectStore.putIfAbsent(packStorageKey, bufferAsAsyncIterable(pack.bytes), {
    hash: packHash,
    hashAlgorithm: 'blake3',
    uncompressedSize: pack.bytes.byteLength,
    compressedSize: pack.bytes.byteLength,
    contentType: 'application/vnd.prosa.object-pack',
  })
  return {
    blobId: `object-pack:${tenantId}:${pack.batchId}:${packHash}`,
    packHash,
    packStorageKey,
    put,
  }
}

async function insertPackCatalog(opts: {
  rawExec: RawExec
  ctx: AuthContext
  pack: ParsedObjectPack
  blobId: string
  packHash: string
  packStorageKey: string
}): Promise<void> {
  await opts.rawExec(
    `INSERT INTO "remote_blob"(id, tenant_id, batch_id, storage_key, hash, hash_algorithm, byte_size)
     VALUES ($1, $2, $3, $4, $5, 'blake3', $6)
     ON CONFLICT (id) DO NOTHING`,
    [opts.blobId, opts.ctx.tenantId, opts.pack.batchId, opts.packStorageKey, opts.packHash, opts.pack.bytes.byteLength],
  )
  for (const entry of opts.pack.entries) {
    await insertPackedRemoteObject(opts.rawExec, entry)
    await insertTenantObjectProof(opts.rawExec, opts.ctx, entry)
    await opts.rawExec(
      `INSERT INTO "remote_object_location"(tenant_id, object_id, batch_id, location_type, blob_id, byte_offset, byte_length)
       VALUES ($1, $2, $3, 'pack', $4, $5, $6)
       ON CONFLICT (tenant_id, object_id) DO NOTHING`,
      [opts.ctx.tenantId, entry.objectId, entry.batchId, opts.blobId, entry.offset, entry.length],
    )
    await assertPackLocationCompatible(opts.rawExec, opts.ctx, entry, opts.blobId)
  }
}

async function insertPackedRemoteObject(rawExec: RawExec, entry: ParsedObjectPack['entries'][number]): Promise<void> {
  await rawExec(
    `INSERT INTO "remote_object"(object_id, hash, hash_algorithm, compression, uncompressed_size, compressed_size, storage_key, content_type)
     VALUES ($1, $2, 'blake3', $3, $4, $5, NULL, $6)
     ON CONFLICT (object_id) DO NOTHING`,
    [
      entry.objectId,
      entry.hash,
      entry.compression,
      entry.uncompressedSize,
      entry.compressedSize,
      entry.contentType ?? null,
    ],
  )
}

async function assertPackLocationCompatible(
  rawExec: RawExec,
  ctx: AuthContext,
  entry: ParsedObjectPack['entries'][number],
  blobId: string,
): Promise<void> {
  const rows = await rawExec<{
    location_type: string
    blob_id: string | null
    byte_offset: string | number
    byte_length: string | number
  }>(
    `SELECT location_type, blob_id, byte_offset, byte_length
       FROM "remote_object_location"
      WHERE tenant_id = $1 AND object_id = $2
      LIMIT 1`,
    [ctx.tenantId, entry.objectId],
  )
  const row = rows[0]
  if (!row) fail(500, 'pack location insert failed')
  if (
    row.location_type !== 'pack' ||
    row.blob_id !== blobId ||
    Number(row.byte_offset) !== entry.offset ||
    Number(row.byte_length) !== entry.length
  ) {
    fail(409, 'conflicting remote object location')
  }
}

async function recordObjectPack(
  deps: ObjectRoutesDeps,
  ctx: AuthContext,
  pack: ParsedObjectPack,
  blob: Awaited<ReturnType<typeof putPackBytes>>,
): Promise<void> {
  try {
    await runObjectRouteTransaction(deps, async (tx) => {
      for (const entry of pack.entries) {
        await assertCatalogCompatible({ ...deps, rawExec: tx }, entry)
      }
      await insertPackCatalog({
        rawExec: tx,
        ctx,
        pack,
        blobId: blob.blobId,
        packHash: blob.packHash,
        packStorageKey: blob.packStorageKey,
      })
    })
  } catch (err) {
    if (!blob.put.alreadyExisted) {
      try {
        await deps.objectStore.delete(blob.packStorageKey)
      } catch {
        // Best-effort cleanup; a catalog miss still keeps packed objects unreadable.
      }
    }
    throw err
  }
}

async function runObjectRouteTransaction<T>(deps: ObjectRoutesDeps, fn: (tx: RawExec) => Promise<T>): Promise<T> {
  if (deps.transaction) return deps.transaction(fn)
  return fn(deps.rawExec)
}

async function findAccessibleObject(
  deps: ObjectRoutesDeps,
  objectId: string,
  tenantId: string,
): Promise<AccessibleObjectRow | null> {
  // CQ-003: a tenant_object row alone is not enough — the object must also
  // have been declared by a verified batch's object manifest. Without the
  // verified-batch join, a committed-but-unverified upload would be
  // readable through this route between commit and verifyPromotion.
  const rows = await deps.rawExec<AccessibleObjectRow>(
    `SELECT ro.hash, ro.hash_algorithm, ro.compression, ro.uncompressed_size,
            ro.compressed_size, ro.storage_key, MAX(to_.tenant_id) AS tenant
       FROM "remote_object" ro
       LEFT JOIN "tenant_object" to_ ON to_.object_id = ro.object_id AND to_.tenant_id = $2
       WHERE ro.object_id = $1
         AND EXISTS (
           SELECT 1 FROM "sync_batch_object_manifest" om
             JOIN "sync_batch" b ON b.id = om.batch_id AND b.status = 'verified'
            WHERE om.tenant_id = $2 AND om.object_id = ro.object_id
         )
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
  const objectPackBinaryBodyLimit = maxObjectBytes + MAX_OBJECT_PACK_BINARY_HEADER_BYTES
  const objectPackJsonBodyLimit = Math.ceil(maxObjectBytes * 1.4) + MAX_OBJECT_PACK_BINARY_HEADER_BYTES
  const objectPackRouteBodyLimit = Math.max(objectPackBinaryBodyLimit, objectPackJsonBodyLimit)
  // Enable raw body parsing for octet-stream so PUT bodies pass through unmodified.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: maxObjectBytes },
    (_req, body, done) => {
      done(null, body)
    },
  )
  app.addContentTypeParser(
    OBJECT_PACK_BINARY_CONTENT_TYPE,
    { parseAs: 'buffer', bodyLimit: objectPackBinaryBodyLimit },
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
        const canReuseExistingLocation = await hasCompatibleObjectBytes({
          rawExec: deps.rawExec,
          objectStore: deps.objectStore,
          object: { ...upload, hashAlgorithm: 'blake3' },
          legacyStorageKey: upload.storageKey,
          tenantId: ctx.tenantId,
          verifyBytes: true,
        })
        if (canReuseExistingLocation) {
          await recordObjectUpload(deps, ctx, upload, {
            alreadyExisted: true,
            meta: {
              storageKey: upload.storageKey,
              hash: upload.transportHash,
              hashAlgorithm: 'blake3',
              uncompressedSize: upload.uncompressedSize,
              compressedSize: upload.compressedSize,
            },
          })
          reply.code(200)
          return {
            objectId: upload.objectId,
            alreadyExisted: true,
          }
        }
        const put = await putObjectBytes(deps, upload, body)
        await recordObjectUpload(deps, ctx, upload, put)

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
    method: 'POST',
    url: '/object-packs',
    bodyLimit: objectPackRouteBodyLimit,
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
        const pack = parseObjectPackRequest(request, maxObjectBytes)
        for (const entry of pack.entries) {
          await assertDeclaredByOpenBatch(deps, ctx, entry)
        }
        await verifyPackBody(pack, maxObjectBytes)
        const blob = await putPackBytes(deps, ctx, pack)
        await recordObjectPack(deps, ctx, pack, blob)
        reply.code(blob.put.alreadyExisted ? 200 : 201)
        return {
          blobId: blob.blobId,
          objectIds: pack.entries.map((entry) => entry.objectId),
          alreadyExisted: blob.put.alreadyExisted,
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
      const location = await resolveObjectByteLocation(deps.rawExec, objectId, ctx.tenantId)
      if (!location) {
        reply.code(404)
        return { error: 'not found' }
      }
      const stream = await readObjectByteLocation(deps.objectStore, location)
      return sendObjectStream(reply, row, stream)
    },
  })
}
