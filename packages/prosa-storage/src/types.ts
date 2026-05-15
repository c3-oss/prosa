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

  /** Removes the object. No-op if it does not exist. */
  delete(key: string): Promise<void>
}

/**
 * Standard fanout for CAS-keyed objects, derived from the BLAKE3 hash. Mirrors
 * the local bundle layout (`objects/blake3/<aa>/<bb>/<hash>.zst`).
 */
export function casObjectKey(hash: string, prefix: string): string {
  const root = prefix.endsWith('/') ? prefix : `${prefix}/`
  return `${root}objects/blake3/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.zst`
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
