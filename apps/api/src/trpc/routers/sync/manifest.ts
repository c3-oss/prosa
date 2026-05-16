import { createHash } from 'node:crypto'
import {
  BLAKE3_HEX_RE,
  type ObjectMeta,
  type RemoteObjectStore,
  canonicalObjectId,
  objectStorageKey,
} from '@c3-oss/prosa-storage'
import type { ObjectManifestEntry } from '@c3-oss/prosa-sync'
import type { RawExec } from '../../../db.js'
import { hasMaterializedObject } from '../../../objects/locations.js'
import { TRPCError } from '../../init.js'

/**
 * Hard caps applied to one batch. Sized to keep promotion plans and receipts
 * small enough to fit comfortably in a single request body and to avoid
 * pathological row-by-row transactions on the projection tables.
 */
export const syncLimits = {
  /** Per-batch object manifest entries. Caps the planned upload list. */
  maxObjectsPerPlan: 5000,
  /** Per-batch projection rows promoted from the local canonical projection. */
  maxRowsPerCommit: 10_000,
  /** Per-object byte ceiling, matches the HTTP upload route body limit. */
  maxObjectBytes: 256 * 1024 * 1024,
}

export type BatchObjectManifestRow = {
  object_id: string
  canonical_hash: string
  transport_hash: string
  compression: 'zstd' | 'none'
  uncompressed_size: string | number
  compressed_size: string | number
  storage_key: string
  content_type: string | null
}

export type RemoteObjectCatalogRow = {
  object_id: string
  hash: string
  hash_algorithm: string
  compression: string
  uncompressed_size: string | number
  compressed_size: string | number
  storage_key: string
}

export type ProjectionEntityType = 'source_file' | 'raw_record' | 'session' | 'search_doc' | 'tool_call' | 'tool_result'

export const objectStoreIoConcurrency = 16

export type ProjectionManifestRow = {
  entity_type: ProjectionEntityType
  entity_id: string
}

export function storageKeyForObject(obj: ObjectManifestEntry): string {
  return objectStorageKey({ hash: obj.hash, compression: obj.compression })
}

export function validateObjectManifest(obj: ObjectManifestEntry): ObjectManifestEntry {
  const hash = obj.hash.toLowerCase()
  const transportHash = (obj.transportHash ?? hash).toLowerCase()
  if (obj.hashAlgorithm !== 'blake3') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only blake3 object manifests are supported' })
  }
  if (!BLAKE3_HEX_RE.test(hash) || !BLAKE3_HEX_RE.test(transportHash)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Object manifests must use 64-character BLAKE3 hex hashes' })
  }
  if (obj.objectId !== canonicalObjectId(hash)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Object objectId must be blake3:<hash>' })
  }
  if (obj.compressedSize > syncLimits.maxObjectBytes || obj.uncompressedSize > syncLimits.maxObjectBytes) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Object exceeds maxObjectBytes limit' })
  }
  return { ...obj, hash, transportHash }
}

export function assertUniqueObjectIds(objects: ObjectManifestEntry[]): void {
  const seen = new Set<string>()
  for (const obj of objects) {
    if (seen.has(obj.objectId)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `Duplicate object_id in manifest: ${obj.objectId}` })
    }
    seen.add(obj.objectId)
  }
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex
        nextIndex += 1
        if (index >= items.length) return
        results[index] = await mapper(items[index] as T, index)
      }
    }),
  )
  return results
}

/**
 * Order-independent JSON serializer used to compute the promotion-receipt
 * digest. Object keys are sorted recursively so two structurally equal
 * payloads always produce the same string (and therefore the same hash),
 * regardless of insertion order. Do not replace with `JSON.stringify` — that
 * preserves insertion order and would break receipt comparison across
 * different clients.
 */
export function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

export function assertSameDeclarationSet(label: string, declared: string[], manifest: string[]): void {
  const declaredSorted = sortedUnique(declared)
  const manifestSorted = sortedUnique(manifest)
  if (
    declaredSorted.length !== declared.length ||
    declaredSorted.length !== manifestSorted.length ||
    declaredSorted.some((value, index) => value !== manifestSorted[index])
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `${label} declarations must exactly match the server-owned batch manifest`,
    })
  }
}

export function objectFromManifestRow(row: BatchObjectManifestRow): ObjectManifestEntry {
  return validateObjectManifest({
    objectId: row.object_id,
    hash: row.canonical_hash,
    hashAlgorithm: 'blake3',
    compression: row.compression,
    uncompressedSize: Number(row.uncompressed_size),
    compressedSize: Number(row.compressed_size),
    transportHash: row.transport_hash,
    ...(row.content_type ? { contentType: row.content_type } : {}),
  })
}

export function assertObjectManifestsMatch(planned: BatchObjectManifestRow[], committed: ObjectManifestEntry[]): void {
  const plannedById = new Map(planned.map((row) => [row.object_id, row]))
  const committedById = new Map(committed.map((obj) => [obj.objectId, obj]))
  if (
    plannedById.size !== planned.length ||
    committedById.size !== committed.length ||
    plannedById.size !== committedById.size
  ) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Commit objects do not match the planned manifest' })
  }
  for (const obj of committed) {
    const plannedObj = plannedById.get(obj.objectId)
    if (!plannedObj) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Commit objects do not match the planned manifest' })
    }
    const plannedEntry = objectFromManifestRow(plannedObj)
    if (
      plannedEntry.hash !== obj.hash ||
      plannedEntry.transportHash !== (obj.transportHash ?? obj.hash) ||
      plannedEntry.compression !== obj.compression ||
      plannedEntry.uncompressedSize !== obj.uncompressedSize ||
      plannedEntry.compressedSize !== obj.compressedSize ||
      plannedObj.storage_key !== storageKeyForObject(obj) ||
      (plannedEntry.contentType ?? null) !== (obj.contentType ?? null)
    ) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Commit objects do not match the planned manifest' })
    }
  }
}

export function buildManifestHash(opts: {
  objects: BatchObjectManifestRow[]
  projection: ProjectionManifestRow[]
}): string {
  const payload = {
    objects: opts.objects
      .map((row) => ({
        objectId: row.object_id,
        canonicalHash: row.canonical_hash,
        transportHash: row.transport_hash,
        compression: row.compression,
        uncompressedSize: Number(row.uncompressed_size),
        compressedSize: Number(row.compressed_size),
        storageKey: row.storage_key,
        contentType: row.content_type,
      }))
      .sort((a, b) => a.objectId.localeCompare(b.objectId)),
    projection: opts.projection
      .map((row) => ({ entityType: row.entity_type, entityId: row.entity_id }))
      .sort((a, b) => `${a.entityType}:${a.entityId}`.localeCompare(`${b.entityType}:${b.entityId}`)),
  }
  return `sha256:${createHash('sha256').update(stableJson(payload)).digest('hex')}`
}

export async function assertRemoteObjectCatalog(opts: {
  rawExec: RawExec
  object: ObjectManifestEntry
  storageKey: string
}): Promise<void> {
  const rows = await opts.rawExec<{
    hash: string
    hash_algorithm: string
    compression: string
    uncompressed_size: string | number
    compressed_size: string | number
    storage_key: string | null
  }>(
    `SELECT hash, hash_algorithm, compression, uncompressed_size, compressed_size, storage_key
       FROM "remote_object" WHERE object_id = $1 LIMIT 1`,
    [opts.object.objectId],
  )
  const row = rows[0]
  if (!row) return
  if (
    row.hash.toLowerCase() !== opts.object.hash ||
    row.hash_algorithm !== 'blake3' ||
    row.compression !== opts.object.compression ||
    Number(row.uncompressed_size) !== opts.object.uncompressedSize ||
    Number(row.compressed_size) !== opts.object.compressedSize ||
    (row.storage_key != null && row.storage_key !== opts.storageKey)
  ) {
    throw new TRPCError({ code: 'CONFLICT', message: `Conflicting remote object metadata for ${opts.object.objectId}` })
  }
}

export async function loadRemoteObjectCatalog(opts: {
  rawExec: RawExec
  objectIds: string[]
}): Promise<Map<string, RemoteObjectCatalogRow>> {
  const uniqueObjectIds = [...new Set(opts.objectIds)]
  if (uniqueObjectIds.length === 0) return new Map()
  const rows = await opts.rawExec<RemoteObjectCatalogRow>(
    `SELECT object_id, hash, hash_algorithm, compression, uncompressed_size, compressed_size, storage_key
       FROM "remote_object"
       WHERE object_id = ANY($1::text[])`,
    [uniqueObjectIds],
  )
  return new Map(rows.map((row) => [row.object_id, row]))
}

export function remoteObjectCatalogMatches(
  row: RemoteObjectCatalogRow,
  object: ObjectManifestEntry,
  storageKey: string,
): boolean {
  return (
    row.hash.toLowerCase() === object.hash &&
    row.hash_algorithm === 'blake3' &&
    row.compression === object.compression &&
    Number(row.uncompressed_size) === object.uncompressedSize &&
    Number(row.compressed_size) === object.compressedSize &&
    row.storage_key === storageKey
  )
}

export async function assertRemoteObjectCatalogs(opts: {
  rawExec: RawExec
  objects: ObjectManifestEntry[]
}): Promise<Map<string, RemoteObjectCatalogRow>> {
  const catalog = await loadRemoteObjectCatalog({
    rawExec: opts.rawExec,
    objectIds: opts.objects.map((object) => object.objectId),
  })
  for (const object of opts.objects) {
    const row = catalog.get(object.objectId)
    if (!row) continue
    const storageKey = storageKeyForObject(object)
    if (!remoteObjectCatalogMatches(row, object, storageKey)) {
      throw new TRPCError({ code: 'CONFLICT', message: `Conflicting remote object metadata for ${object.objectId}` })
    }
  }
  return catalog
}

export function objectStoreHeadMatches(head: ObjectMeta | null, object: ObjectManifestEntry): boolean {
  const transportHash = object.transportHash ?? object.hash
  return (
    !!head &&
    head.hash.toLowerCase() === transportHash &&
    head.compressedSize === object.compressedSize &&
    head.uncompressedSize === object.uncompressedSize
  )
}

export async function requireStoredObject(opts: {
  rawExec: RawExec
  objectStore: RemoteObjectStore
  object: ObjectManifestEntry
  storageKey: string
  tenantId: string
}): Promise<void> {
  if (
    await hasMaterializedObject({
      rawExec: opts.rawExec,
      objectStore: opts.objectStore,
      object: opts.object,
      legacyStorageKey: opts.storageKey,
      tenantId: opts.tenantId,
      verifyBytes: true,
    })
  ) {
    return
  }
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: `Object bytes are missing or mismatched for ${opts.object.objectId}`,
  })
}

export async function findMissingObjectIds(opts: {
  rawExec: RawExec
  objectStore: RemoteObjectStore
  objects: ObjectManifestEntry[]
  tenantId: string
}): Promise<string[]> {
  const missing: string[] = []
  for (const obj of opts.objects) {
    const storageKey = storageKeyForObject(obj)
    if (
      !(await hasMaterializedObject({
        rawExec: opts.rawExec,
        objectStore: opts.objectStore,
        object: obj,
        legacyStorageKey: storageKey,
        tenantId: opts.tenantId,
      }))
    ) {
      missing.push(obj.objectId)
    }
  }
  return missing
}

export async function loadObjectManifest(
  rawExec: RawExec,
  batchId: string,
  tenantId: string,
): Promise<BatchObjectManifestRow[]> {
  return rawExec<BatchObjectManifestRow>(
    `SELECT object_id, canonical_hash, transport_hash, compression, uncompressed_size,
            compressed_size, storage_key, content_type
       FROM "sync_batch_object_manifest"
       WHERE batch_id = $1 AND tenant_id = $2
       ORDER BY object_id`,
    [batchId, tenantId],
  )
}
