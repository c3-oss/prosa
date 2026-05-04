import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Bundle } from '../bundle.js';
import { prepare } from '../db.js';
import { type Compression, compressBytes, decompressBytes } from './compress.js';
import { blake3Hex, objectIdFromHash, objectStoragePath } from './hash.js';

export type ObjectId = string;

export interface ObjectMeta {
  object_id: ObjectId;
  hash_alg: 'blake3';
  hash: string;
  size_bytes: number;
  compressed_size_bytes: number | null;
  compression: Compression;
  mime_type: string | null;
  encoding: string | null;
  storage_path: string;
  created_at: string;
}

interface PutOptions {
  mimeType?: string;
  encoding?: string;
}

/**
 * Store raw bytes in the CAS. Returns the object_id. Idempotent: if the same
 * content already exists, returns the existing object_id without rewriting.
 *
 * Bytes are compressed with zstd when worth it (see compress.ts threshold).
 * The on-disk path is `<bundle>/objects/blake3/ab/cd/<hash>.zst`.
 */
export async function putBytes(
  bundle: Bundle,
  bytes: Uint8Array,
  options: PutOptions = {},
): Promise<ObjectId> {
  const hash = blake3Hex(bytes);
  const objectId = objectIdFromHash(hash);

  const existing = prepare<[string], ObjectMeta>(
    bundle.db,
    `SELECT object_id, hash_alg, hash, size_bytes, compressed_size_bytes,
            compression, mime_type, encoding, storage_path, created_at
       FROM objects WHERE object_id = ?`,
  ).get(objectId);

  if (existing) return objectId;

  const { bytes: stored, compression } = compressBytes(bytes);
  const storagePath = objectStoragePath(hash, compression);
  const absolutePath = path.join(bundle.path, storagePath);

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, stored);

  prepare(
    bundle.db,
    `INSERT INTO objects (
       object_id, hash_alg, hash, size_bytes, compressed_size_bytes,
       compression, mime_type, encoding, storage_path, created_at
     ) VALUES (?, 'blake3', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    objectId,
    hash,
    bytes.byteLength,
    compression === 'zstd' ? stored.byteLength : null,
    compression,
    options.mimeType ?? null,
    options.encoding ?? null,
    storagePath,
    new Date().toISOString(),
  );

  return objectId;
}

export async function putText(
  bundle: Bundle,
  text: string,
  options: { mimeType?: string } = {},
): Promise<ObjectId> {
  const buf = Buffer.from(text, 'utf8');
  return putBytes(bundle, buf, {
    mimeType: options.mimeType ?? 'text/plain; charset=utf-8',
    encoding: 'utf-8',
  });
}

export async function putJson(bundle: Bundle, value: unknown): Promise<ObjectId> {
  // Compact serialization. Stable enough for the importer's own writes; we
  // don't promise canonical JSON across producers.
  const text = JSON.stringify(value);
  return putBytes(bundle, Buffer.from(text, 'utf8'), {
    mimeType: 'application/json',
    encoding: 'utf-8',
  });
}

export async function getBytes(bundle: Bundle, objectId: ObjectId): Promise<Buffer> {
  const meta = prepare<[string], ObjectMeta>(
    bundle.db,
    `SELECT object_id, hash_alg, hash, size_bytes, compressed_size_bytes,
            compression, mime_type, encoding, storage_path, created_at
       FROM objects WHERE object_id = ?`,
  ).get(objectId);
  if (!meta) {
    throw new Error(`object not found: ${objectId}`);
  }
  const buf = await readFile(path.join(bundle.path, meta.storage_path));
  return decompressBytes(buf, meta.compression);
}

export async function getText(bundle: Bundle, objectId: ObjectId): Promise<string> {
  const buf = await getBytes(bundle, objectId);
  return buf.toString('utf8');
}

export async function getJson<T = unknown>(bundle: Bundle, objectId: ObjectId): Promise<T> {
  const text = await getText(bundle, objectId);
  return JSON.parse(text) as T;
}

export function getObjectMeta(bundle: Bundle, objectId: ObjectId): ObjectMeta | null {
  return (
    prepare<[string], ObjectMeta>(
      bundle.db,
      `SELECT object_id, hash_alg, hash, size_bytes, compressed_size_bytes,
              compression, mime_type, encoding, storage_path, created_at
         FROM objects WHERE object_id = ?`,
    ).get(objectId) ?? null
  );
}
