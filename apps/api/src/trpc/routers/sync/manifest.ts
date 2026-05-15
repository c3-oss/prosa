import { createHash } from 'node:crypto'
import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import type { ObjectManifestEntry } from '@c3-oss/prosa-sync'
import type { RawExec } from '../../../db.js'
import { TRPCError } from '../../init.js'

export const syncLimits = {
  maxObjectsPerPlan: 5000,
  maxRowsPerCommit: 10_000,
  maxObjectBytes: 256 * 1024 * 1024,
}

const BLAKE3_HEX_RE = /^[0-9a-f]{64}$/i

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

export type ProjectionEntityType = 'source_file' | 'raw_record' | 'session' | 'search_doc'

export type ProjectionManifestRow = {
  entity_type: ProjectionEntityType
  entity_id: string
}

function canonicalObjectId(hash: string): string {
  return `blake3:${hash.toLowerCase()}`
}

export function storageKeyForObject(obj: ObjectManifestEntry): string {
  const ext = obj.compression === 'none' ? '.bin' : '.zst'
  return `objects/blake3/${obj.hash.slice(0, 2)}/${obj.hash.slice(2, 4)}/${obj.hash}${ext}`
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
    storage_key: string
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
    row.storage_key !== opts.storageKey
  ) {
    throw new TRPCError({ code: 'CONFLICT', message: `Conflicting remote object metadata for ${opts.object.objectId}` })
  }
}

export async function requireStoredObject(opts: {
  objectStore: RemoteObjectStore
  object: ObjectManifestEntry
  storageKey: string
}): Promise<void> {
  const head = await opts.objectStore.head(opts.storageKey)
  const transportHash = opts.object.transportHash ?? opts.object.hash
  if (
    !head ||
    head.hash.toLowerCase() !== transportHash ||
    head.compressedSize !== opts.object.compressedSize ||
    head.uncompressedSize !== opts.object.uncompressedSize
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Object bytes are missing or mismatched for ${opts.object.objectId}`,
    })
  }
}

export async function findMissingObjectIds(opts: {
  rawExec: RawExec
  objectStore: RemoteObjectStore
  objects: ObjectManifestEntry[]
}): Promise<string[]> {
  const missing: string[] = []
  for (const obj of opts.objects) {
    const storageKey = storageKeyForObject(obj)
    const exists = await opts.rawExec('SELECT 1 FROM "remote_object" WHERE object_id = $1 LIMIT 1', [obj.objectId])
    const head = await opts.objectStore.head(storageKey)
    const transportHash = obj.transportHash ?? obj.hash
    if (
      exists.length === 0 ||
      !head ||
      head.hash.toLowerCase() !== transportHash ||
      head.compressedSize !== obj.compressedSize ||
      head.uncompressedSize !== obj.uncompressedSize
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
