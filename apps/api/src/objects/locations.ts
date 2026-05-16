import { Readable } from 'node:stream'
import { type RemoteObjectStore, computeHashHex } from '@c3-oss/prosa-storage'
import type { ObjectManifestEntry } from '@c3-oss/prosa-sync'
import { DecompressStream } from 'zstd-napi'
import type { RawExec } from '../db.js'

export type ObjectByteLocation = {
  storageKey: string
  offset: number
  length: number
  packed: boolean
}

type LocationRow = {
  hash: string
  hash_algorithm: string
  compression: string
  uncompressed_size: string | number
  compressed_size: string | number
  legacy_storage_key: string | null
  location_type: string | null
  location_storage_key: string | null
  blob_storage_key: string | null
  blob_hash: string | null
  blob_hash_algorithm: string | null
  blob_byte_size: string | number | null
  byte_offset: string | number | null
  byte_length: string | number | null
}

export async function resolveObjectByteLocation(
  rawExec: RawExec,
  objectId: string,
  tenantId: string,
): Promise<ObjectByteLocation | null> {
  const rows = await rawExec<LocationRow>(
    `SELECT ro.hash,
            ro.hash_algorithm,
            ro.compression,
            ro.uncompressed_size,
            ro.compressed_size,
            ro.storage_key AS legacy_storage_key,
            l.location_type,
            l.storage_key AS location_storage_key,
            b.storage_key AS blob_storage_key,
            b.hash AS blob_hash,
            b.hash_algorithm AS blob_hash_algorithm,
            b.byte_size AS blob_byte_size,
            l.byte_offset,
            l.byte_length
       FROM "remote_object" ro
  LEFT JOIN "remote_object_location" l ON l.object_id = ro.object_id
                                      AND l.tenant_id = $2
  LEFT JOIN "remote_blob" b ON b.id = l.blob_id
      WHERE ro.object_id = $1
      LIMIT 1`,
    [objectId, tenantId],
  )
  const row = rows[0]
  if (!row) return null
  const compressedSize = Number(row.compressed_size)
  if (row.location_type === 'pack') {
    const storageKey = row.blob_storage_key ?? row.location_storage_key
    if (!storageKey || row.byte_offset == null || row.byte_length == null) return null
    return {
      storageKey,
      offset: Number(row.byte_offset),
      length: Number(row.byte_length),
      packed: true,
    }
  }
  const storageKey = row.location_storage_key ?? row.legacy_storage_key
  if (!storageKey) return null
  return {
    storageKey,
    offset: 0,
    length: Number(row.byte_length ?? compressedSize),
    packed: false,
  }
}

export async function readObjectByteLocation(
  objectStore: RemoteObjectStore,
  location: ObjectByteLocation,
): Promise<ReadableStream<Uint8Array>> {
  if (location.packed) {
    return objectStore.getRange(location.storageKey, location.offset, location.length)
  }
  return objectStore.get(location.storageKey)
}

export async function hasMaterializedObject(opts: {
  rawExec: RawExec
  objectStore: RemoteObjectStore
  object: ObjectManifestEntry
  legacyStorageKey: string
  tenantId: string
  verifyBytes?: boolean
}): Promise<boolean> {
  const tenantRows = await opts.rawExec<{ object_id: string }>(
    'SELECT object_id FROM "tenant_object" WHERE tenant_id = $1 AND object_id = $2 LIMIT 1',
    [opts.tenantId, opts.object.objectId],
  )
  if (!tenantRows[0]) return false
  return hasCompatibleObjectBytes(opts)
}

export async function hasCompatibleObjectBytes(opts: {
  rawExec: RawExec
  objectStore: RemoteObjectStore
  object: ObjectManifestEntry
  legacyStorageKey: string
  tenantId: string
  verifyBytes?: boolean
}): Promise<boolean> {
  const rows = await opts.rawExec<LocationRow>(
    `SELECT ro.hash,
            ro.hash_algorithm,
            ro.compression,
            ro.uncompressed_size,
            ro.compressed_size,
            ro.storage_key AS legacy_storage_key,
            l.location_type,
            l.storage_key AS location_storage_key,
            b.storage_key AS blob_storage_key,
            b.hash AS blob_hash,
            b.hash_algorithm AS blob_hash_algorithm,
            b.byte_size AS blob_byte_size,
            l.byte_offset,
            l.byte_length
       FROM "remote_object" ro
  LEFT JOIN "remote_object_location" l ON l.object_id = ro.object_id
                                      AND l.tenant_id = $2
  LEFT JOIN "remote_blob" b ON b.id = l.blob_id
      WHERE ro.object_id = $1
      LIMIT 1`,
    [opts.object.objectId, opts.tenantId],
  )
  const row = rows[0]
  if (!row || !catalogMetadataMatches(row, opts.object)) return false
  const location = await resolveObjectByteLocation(opts.rawExec, opts.object.objectId, opts.tenantId)
  if (location) {
    if (!locationMatchesObject(location, opts.object)) return false
    const head = await opts.objectStore.head(location.storageKey)
    if (!head) return false
    if (location.packed) {
      if (!packedBlobMatches(row, head, location)) return false
      return opts.verifyBytes ? verifyLocationBytes(opts.objectStore, location, opts.object) : true
    }
    const transportHash = opts.object.transportHash ?? opts.object.hash
    const matches =
      head.hash.toLowerCase() === transportHash &&
      head.compressedSize === opts.object.compressedSize &&
      head.uncompressedSize === opts.object.uncompressedSize
    return matches && (!opts.verifyBytes || (await verifyLocationBytes(opts.objectStore, location, opts.object)))
  }
  const head = await opts.objectStore.head(opts.legacyStorageKey)
  const transportHash = opts.object.transportHash ?? opts.object.hash
  const matches =
    head != null &&
    head.hash.toLowerCase() === transportHash &&
    head.compressedSize === opts.object.compressedSize &&
    head.uncompressedSize === opts.object.uncompressedSize
  if (!matches) return false
  return (
    !opts.verifyBytes ||
    (await verifyLocationBytes(
      opts.objectStore,
      {
        storageKey: opts.legacyStorageKey,
        offset: 0,
        length: opts.object.compressedSize,
        packed: false,
      },
      opts.object,
    ))
  )
}

function packedBlobMatches(
  row: LocationRow,
  head: Awaited<ReturnType<RemoteObjectStore['head']>>,
  location: ObjectByteLocation,
): boolean {
  if (!head || !row.blob_hash || !row.blob_hash_algorithm || row.blob_byte_size == null) return false
  const blobSize = Number(row.blob_byte_size)
  return (
    Number.isSafeInteger(blobSize) &&
    blobSize >= 0 &&
    location.offset + location.length <= blobSize &&
    head.hash.toLowerCase() === row.blob_hash.toLowerCase() &&
    head.hashAlgorithm === row.blob_hash_algorithm &&
    head.compressedSize === blobSize &&
    head.uncompressedSize === blobSize
  )
}

function catalogMetadataMatches(row: LocationRow, object: ObjectManifestEntry): boolean {
  return (
    row.hash.toLowerCase() === object.hash &&
    row.hash_algorithm === 'blake3' &&
    row.compression === object.compression &&
    Number(row.uncompressed_size) === object.uncompressedSize &&
    Number(row.compressed_size) === object.compressedSize
  )
}

function locationMatchesObject(location: ObjectByteLocation, object: ObjectManifestEntry): boolean {
  return Number.isSafeInteger(location.offset) && location.offset >= 0 && location.length === object.compressedSize
}

async function verifyLocationBytes(
  objectStore: RemoteObjectStore,
  location: ObjectByteLocation,
  object: ObjectManifestEntry,
): Promise<boolean> {
  const encoded = await readLocationBytes(objectStore, location)
  const transportHash = object.transportHash ?? object.hash
  if (encoded.byteLength !== object.compressedSize || computeHashHex(encoded, 'blake3') !== transportHash) {
    return false
  }
  const plain = object.compression === 'none' ? encoded : await decompressBytes(encoded, object.uncompressedSize)
  return plain.byteLength === object.uncompressedSize && computeHashHex(plain, 'blake3') === object.hash
}

async function readLocationBytes(objectStore: RemoteObjectStore, location: ObjectByteLocation): Promise<Buffer> {
  const stream = await readObjectByteLocation(objectStore, location)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
    total,
  )
}

async function decompressBytes(encoded: Buffer, expectedUncompressedSize: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  const decompressed = Readable.from([encoded]).pipe(new DecompressStream())
  try {
    for await (const chunk of decompressed) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.byteLength
      if (total > expectedUncompressedSize) {
        decompressed.destroy()
        return Buffer.alloc(0)
      }
      chunks.push(buffer)
    }
  } catch {
    return Buffer.alloc(0)
  }
  return Buffer.concat(chunks, total)
}
