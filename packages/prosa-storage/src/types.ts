export type ObjectMeta = {
  hash: string
  hashAlgorithm: 'blake3' | 'sha256'
  uncompressedSize: number
  compressedSize: number
  contentType?: string
  /** Adapter-specific opaque key recorded in the catalog. */
  storageKey: string
}

export type PutMeta = Omit<ObjectMeta, 'storageKey'> & { contentType?: string }

export type PutResult = {
  meta: ObjectMeta
  /** True when the object already existed and the put was treated as a no-op. */
  alreadyExisted: boolean
}

export interface RemoteObjectStore {
  /** Returns metadata for the object, or null if missing. */
  head(key: string): Promise<ObjectMeta | null>

  /**
   * Writes bytes if and only if the key does not already exist. If the key
   * exists, returns the existing metadata with `alreadyExisted=true` and does
   * not consume `bytes`.
   */
  putIfAbsent(key: string, bytes: AsyncIterable<Uint8Array>, meta: PutMeta): Promise<PutResult>

  /** Reads bytes as a Web ReadableStream. */
  get(key: string): Promise<ReadableStream<Uint8Array>>

  /** Reads a byte range as a Web ReadableStream. */
  getRange(key: string, offset: number, length: number): Promise<ReadableStream<Uint8Array>>

  /** Removes the object. No-op if it does not exist. */
  delete(key: string): Promise<void>
}

export const PUT_PREVERIFIED_BYTES = Symbol.for('@c3-oss/prosa-storage.putPreverifiedBytes')

export type PreverifiedRemoteObjectStore = RemoteObjectStore & {
  /**
   * Server-internal fast path for callers that already verified byte size and
   * hash before invoking the adapter. The public `putIfAbsent` contract still
   * verifies all new bytes.
   */
  [PUT_PREVERIFIED_BYTES](key: string, bytes: AsyncIterable<Uint8Array>, meta: PutMeta): Promise<PutResult>
}

export function supportsPreverifiedPut(store: RemoteObjectStore): store is PreverifiedRemoteObjectStore {
  return typeof (store as Partial<PreverifiedRemoteObjectStore>)[PUT_PREVERIFIED_BYTES] === 'function'
}

export function putPreverifiedIfAbsent(
  store: RemoteObjectStore,
  key: string,
  bytes: AsyncIterable<Uint8Array>,
  meta: PutMeta,
): Promise<PutResult> {
  if (supportsPreverifiedPut(store)) {
    return store[PUT_PREVERIFIED_BYTES](key, bytes, meta)
  }
  return store.putIfAbsent(key, bytes, meta)
}

export type ObjectCompression = 'zstd' | 'none'

/**
 * BLAKE3 hex hashes are 32 bytes / 64 hex characters. The regex is anchored
 * because we use it to validate untrusted client input.
 */
export const BLAKE3_HEX_RE = /^[0-9a-f]{64}$/i

/** Build the canonical `blake3:<hash>` object id used in manifests and routes. */
export function canonicalObjectId(hash: string): string {
  return `blake3:${hash.toLowerCase()}`
}

/**
 * Standard fanout for CAS-keyed objects, derived from the BLAKE3 hash. Mirrors
 * the local bundle layout (`objects/blake3/<aa>/<bb>/<hash>.zst`).
 */
export function casObjectKey(hash: string, prefix: string): string {
  const root = prefix.endsWith('/') ? prefix : `${prefix}/`
  return `${root}objects/blake3/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.zst`
}

/**
 * Server-side variant of {@link casObjectKey}: no prefix and the extension
 * tracks the compression actually applied (`.zst` for zstd, `.bin` for raw).
 */
export function objectStorageKey(opts: { hash: string; compression: ObjectCompression }): string {
  const ext = opts.compression === 'zstd' ? '.zst' : '.bin'
  return `objects/blake3/${opts.hash.slice(0, 2)}/${opts.hash.slice(2, 4)}/${opts.hash}${ext}`
}

export function objectPackStorageKey(opts: { tenantId: string; batchId: string; packHash: string }): string {
  return `object-packs/${opts.tenantId}/${opts.batchId}/${opts.packHash}.pack`
}

export function rawSourceKey(tenantId: string, sourceFileId: string, prefix: string): string {
  const root = prefix.endsWith('/') ? prefix : `${prefix}/`
  return `${root}raw/sources/${tenantId}/${sourceFileId}.zst`
}

export function artifactKey(tenantId: string, artifactId: string, prefix: string): string {
  const root = prefix.endsWith('/') ? prefix : `${prefix}/`
  return `${root}artifacts/${tenantId}/${artifactId}`
}

export function exportKey(tenantId: string, snapshotId: string, filename: string, prefix: string): string {
  const root = prefix.endsWith('/') ? prefix : `${prefix}/`
  return `${root}exports/parquet/${tenantId}/${snapshotId}/${filename}`
}

export async function asyncIterableToUint8Array(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of stream) {
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export function uint8ArrayToWebStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}
