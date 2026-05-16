import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Bundle } from '../bundle.js'
import { prepare } from '../db.js'
import { type Compression, compressBytes, decompressBytes } from './compress.js'
import { blake3Hex, blake3HexAsync, objectIdFromHash, objectStoragePath } from './hash.js'

/**
 * Content-addressed object identifier stored as `blake3:<hex>`.
 */
export type ObjectId = string

/**
 * Complete metadata row for one object stored in the CAS.
 *
 * `storage_path` is relative to the bundle root and points at compressed or
 * raw bytes depending on `compression`.
 */
export interface ObjectMeta {
  /** Canonical object identifier, formatted as `blake3:<hex>`. */
  object_id: ObjectId
  /** Hash algorithm used to derive `hash` and `object_id`. */
  hash_alg: 'blake3'
  /** Raw BLAKE3 hex digest without the `blake3:` prefix. */
  hash: string
  /** Original uncompressed payload size in bytes. */
  size_bytes: number
  /** Stored compressed payload size, or null when stored uncompressed. */
  compressed_size_bytes: number | null
  /** Compression algorithm used for the stored payload. */
  compression: Compression
  /** Optional media type supplied by the writer. */
  mime_type: string | null
  /** Optional text encoding supplied by the writer. */
  encoding: string | null
  /** Bundle-relative path to the stored bytes. */
  storage_path: string
  /** BLAKE3 hex digest of the bytes stored on disk and uploaded over sync. */
  transport_hash: string | null
  /** ISO timestamp for the metadata row insertion. */
  created_at: string
}

/**
 * Optional MIME and text-encoding metadata for newly stored CAS objects.
 */
export interface PutOptions {
  /** Optional media type to persist on the object metadata row. */
  mimeType?: string
  /** Optional text encoding to persist on the object metadata row. */
  encoding?: string
}

/**
 * Per-process cache of directories we've already mkdir'd. The CAS fanout
 * creates `objects/blake3/ab/cd/` for 65k possible leaves; calling
 * `mkdir(... { recursive: true })` for every staged object during a large
 * import was a measurable cost. Cache by absolute path.
 */
const ensuredDirs = new Set<string>()

export async function ensureDir(absoluteDir: string): Promise<void> {
  if (ensuredDirs.has(absoluteDir)) return
  await mkdir(absoluteDir, { recursive: true })
  ensuredDirs.add(absoluteDir)
}

/**
 * Store raw bytes in the CAS. Returns the object_id. Idempotent: if the same
 * content already exists, returns the existing object_id without rewriting.
 *
 * Bytes are compressed with zstd when worth it (see compress.ts threshold).
 * The on-disk path is `<bundle>/objects/blake3/ab/cd/<hash>.zst`.
 */
export async function putBytes(bundle: Bundle, bytes: Uint8Array, options: PutOptions = {}): Promise<ObjectId> {
  const hash = await blake3HexAsync(bytes)
  const objectId = objectIdFromHash(hash)

  const existing = prepare<[string], ObjectMeta>(
    bundle.db,
    `SELECT object_id, hash_alg, hash, size_bytes, compressed_size_bytes,
            compression, mime_type, encoding, storage_path, transport_hash, created_at
       FROM objects WHERE object_id = ?`,
  ).get(objectId)

  if (existing) return objectId

  const { bytes: stored, compression } = compressBytes(bytes)
  const storagePath = objectStoragePath(hash, compression)
  const absolutePath = path.join(bundle.path, storagePath)

  await ensureDir(path.dirname(absolutePath))
  await writeFile(absolutePath, stored)

  prepare(
    bundle.db,
    `INSERT INTO objects (
       object_id, hash_alg, hash, size_bytes, compressed_size_bytes,
       compression, mime_type, encoding, storage_path, transport_hash, created_at
     ) VALUES (?, 'blake3', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    objectId,
    hash,
    bytes.byteLength,
    compression === 'zstd' ? stored.byteLength : null,
    compression,
    options.mimeType ?? null,
    options.encoding ?? null,
    storagePath,
    await blake3HexAsync(stored),
    new Date().toISOString(),
  )

  return objectId
}

/**
 * Store UTF-8 text in the CAS with text metadata.
 */
export async function putText(bundle: Bundle, text: string, options: { mimeType?: string } = {}): Promise<ObjectId> {
  const buf = Buffer.from(text, 'utf8')
  return putBytes(bundle, buf, {
    mimeType: options.mimeType ?? 'text/plain; charset=utf-8',
    encoding: 'utf-8',
  })
}

/**
 * Store a JSON-serialized value in the CAS.
 *
 * Serialization is compact but not canonicalized; callers should not rely on
 * object key ordering for cross-process identity unless the input itself is
 * produced deterministically.
 */
export async function putJson(bundle: Bundle, value: unknown): Promise<ObjectId> {
  // Compact serialization. Stable enough for the importer's own writes; we
  // don't promise canonical JSON across producers.
  const text = JSON.stringify(value)
  return putBytes(bundle, Buffer.from(text, 'utf8'), {
    mimeType: 'application/json',
    encoding: 'utf-8',
  })
}

/**
 * Read and decompress object bytes from the CAS.
 *
 * Throws when `objectId` is absent from the `objects` table; filesystem read or
 * decompression errors also propagate because they indicate bundle corruption
 * or inaccessible storage.
 */
export async function getBytes(bundle: Bundle, objectId: ObjectId): Promise<Buffer> {
  const meta = prepare<[string], ObjectMeta>(
    bundle.db,
    `SELECT object_id, hash_alg, hash, size_bytes, compressed_size_bytes,
            compression, mime_type, encoding, storage_path, transport_hash, created_at
       FROM objects WHERE object_id = ?`,
  ).get(objectId)
  if (!meta) {
    throw new Error(`object not found: ${objectId}`)
  }
  const buf = await readFile(path.join(bundle.path, meta.storage_path))
  return decompressBytes(buf, meta.compression)
}

/**
 * Read an object as UTF-8 text.
 */
export async function getText(bundle: Bundle, objectId: ObjectId): Promise<string> {
  const buf = await getBytes(bundle, objectId)
  return buf.toString('utf8')
}

/**
 * Read an object as UTF-8 JSON and parse it as `T`.
 */
export async function getJson<T = unknown>(bundle: Bundle, objectId: ObjectId): Promise<T> {
  const text = await getText(bundle, objectId)
  return JSON.parse(text) as T
}

/**
 * Look up object metadata without reading object bytes.
 */
export function getObjectMeta(bundle: Bundle, objectId: ObjectId): ObjectMeta | null {
  return (
    prepare<[string], ObjectMeta>(
      bundle.db,
      `SELECT object_id, hash_alg, hash, size_bytes, compressed_size_bytes,
              compression, mime_type, encoding, storage_path, transport_hash, created_at
         FROM objects WHERE object_id = ?`,
    ).get(objectId) ?? null
  )
}

// -- Staging API for high-volume importers ---------------------------------
//
// Importers parse thousands of records per file and call putBytes/putJson per
// record. Doing each as its own SQLite auto-commit + mkdir + writeFile is the
// dominant cost on a fresh import. The staging API splits CAS work into:
//
//   1. stageBytes/stageJson/stageText — synchronous; computes the blake3 hash,
//      builds the ObjectId, and accumulates pending bytes in a per-batch Map
//      deduped by ObjectId. Returns the ObjectId immediately so the rest of
//      the importer can reference it.
//   2. flushPendingObjects — async; runs once per batch. Bulk-checks which
//      ObjectIds already exist, writes the missing files in parallel, then
//      bulk-inserts the new `objects` rows in a single transaction.
//
// The shape lets importers keep their existing
// `transactional(bundle.db, () => flushPending(...))` block as the only
// SQLite write boundary for the file, with `flushPendingObjects` running just
// before that (FS writes can't run inside a sync transaction).

/**
 * Object staged for a high-volume importer flush.
 *
 * Bytes are the original uncompressed payload; compression and storage path are
 * decided once during `flushPendingObjects`.
 */
export interface StagedObject {
  objectId: ObjectId
  hash: string
  bytes: Buffer
  mimeType: string | null
  encoding: string | null
}

/**
 * Mutable per-import accumulator of staged CAS objects, deduped by object ID.
 */
export interface PendingObjects {
  byId: Map<ObjectId, StagedObject>
}

/**
 * Create an empty CAS staging accumulator.
 */
export function createPendingObjects(): PendingObjects {
  return { byId: new Map() }
}

/**
 * Stage bytes for later CAS persistence and return their object ID.
 *
 * This is synchronous and idempotent within the pending set; the first staged
 * metadata for a given object ID wins.
 */
export function stageBytes(pending: PendingObjects, bytes: Uint8Array, options: PutOptions = {}): ObjectId {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const hash = blake3Hex(buf)
  const objectId = objectIdFromHash(hash)
  if (!pending.byId.has(objectId)) {
    pending.byId.set(objectId, {
      objectId,
      hash,
      bytes: buf,
      mimeType: options.mimeType ?? null,
      encoding: options.encoding ?? null,
    })
  }
  return objectId
}

/**
 * Stage UTF-8 text for later CAS persistence.
 */
export function stageText(pending: PendingObjects, text: string, options: { mimeType?: string } = {}): ObjectId {
  return stageBytes(pending, Buffer.from(text, 'utf8'), {
    mimeType: options.mimeType ?? 'text/plain; charset=utf-8',
    encoding: 'utf-8',
  })
}

/**
 * Stage a compact JSON representation for later CAS persistence.
 */
export function stageJson(pending: PendingObjects, value: unknown): ObjectId {
  return stageBytes(pending, Buffer.from(JSON.stringify(value), 'utf8'), {
    mimeType: 'application/json',
    encoding: 'utf-8',
  })
}

/**
 * Flush every staged object to disk and to the `objects` table.
 *
 * Writes happen before the caller's domain transaction starts because
 * better-sqlite3 transactions are synchronous and we want to overlap the
 * filesystem writes with each other. The `objects` rows are inserted with
 * INSERT OR IGNORE, so any rows another writer added between our existence
 * check and our insert are tolerated.
 */
export async function flushPendingObjects(bundle: Bundle, pending: PendingObjects): Promise<void> {
  if (pending.byId.size === 0) return

  const ids = [...pending.byId.keys()]
  const existingIds = queryExistingObjectIds(bundle, ids)

  // Compress once. The same buffer + path are reused for the FS write and
  // the `objects` row.
  /**
   * Fully prepared representation used for both filesystem and SQLite writes.
   */
  interface PreparedObject {
    staged: StagedObject
    compression: Compression
    compressedBytes: Buffer
    storagePath: string
    absolutePath: string
  }
  const toWrite: PreparedObject[] = []
  for (const obj of pending.byId.values()) {
    if (existingIds.has(obj.objectId)) continue
    const { bytes: compressedBytes, compression } = compressBytes(obj.bytes)
    const storagePath = objectStoragePath(obj.hash, compression)
    toWrite.push({
      staged: obj,
      compression,
      compressedBytes,
      storagePath,
      absolutePath: path.join(bundle.path, storagePath),
    })
  }

  if (toWrite.length > 0) {
    await writeFilesParallel(toWrite)
  }

  // Compute transport hashes in parallel using WASM before entering the sync
  // SQLite insert loop. Promise.all lets the WASM calls overlap.
  const transportHashes = await Promise.all(toWrite.map((p) => blake3HexAsync(p.compressedBytes)))

  const insertObject = prepare(
    bundle.db,
    `INSERT OR IGNORE INTO objects (
       object_id, hash_alg, hash, size_bytes, compressed_size_bytes,
       compression, mime_type, encoding, storage_path, transport_hash, created_at
     ) VALUES (?, 'blake3', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const now = new Date().toISOString()
  for (const [i, p] of toWrite.entries()) {
    insertObject.run(
      p.staged.objectId,
      p.staged.hash,
      p.staged.bytes.byteLength,
      p.compression === 'zstd' ? p.compressedBytes.byteLength : null,
      p.compression,
      p.staged.mimeType,
      p.staged.encoding,
      p.storagePath,
      transportHashes[i],
      now,
    )
  }
}

/**
 * Query existing object IDs in chunks to stay below SQLite variable limits.
 */
function queryExistingObjectIds(bundle: Bundle, ids: ObjectId[]): Set<ObjectId> {
  const found = new Set<ObjectId>()
  if (ids.length === 0) return found
  // SQLite's default SQLITE_LIMIT_VARIABLE_NUMBER is 32766; chunk well under
  // that for safety.
  const CHUNK = 500
  for (let start = 0; start < ids.length; start += CHUNK) {
    const slice = ids.slice(start, start + CHUNK)
    const placeholders = slice.map(() => '?').join(',')
    const rows = bundle.db
      .prepare<ObjectId[], { object_id: ObjectId }>(
        `SELECT object_id FROM objects WHERE object_id IN (${placeholders})`,
      )
      .all(...slice)
    for (const row of rows) found.add(row.object_id)
  }
  return found
}

/**
 * Maximum concurrent filesystem writes during staged CAS flushes.
 */
const FS_WRITE_CONCURRENCY = 16

/**
 * Write compressed object payloads with bounded concurrency.
 *
 * Directory creation is cached via `ensureDir`; individual write failures
 * reject the whole flush.
 */
async function writeFilesParallel(tasks: { absolutePath: string; compressedBytes: Buffer }[]): Promise<void> {
  let cursor = 0
  const workers: Promise<void>[] = []
  const limit = Math.min(FS_WRITE_CONCURRENCY, tasks.length)
  for (let w = 0; w < limit; w++) {
    workers.push(
      (async () => {
        while (true) {
          const i = cursor++
          if (i >= tasks.length) return
          const task = tasks[i]!
          await ensureDir(path.dirname(task.absolutePath))
          await writeFile(task.absolutePath, task.compressedBytes)
        }
      })(),
    )
  }
  await Promise.all(workers)
}
