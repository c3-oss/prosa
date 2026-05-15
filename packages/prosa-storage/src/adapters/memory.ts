import {
  type ObjectMeta,
  type PutMeta,
  type PutResult,
  type RemoteObjectStore,
  asyncIterableToUint8Array,
  uint8ArrayToWebStream,
} from '../types.js'

type Entry = { bytes: Uint8Array; meta: ObjectMeta }

/**
 * In-process object store. Useful for tests; the spec also designates it as
 * the only acceptable backend for the test suite.
 */
export class MemoryObjectStore implements RemoteObjectStore {
  private readonly entries = new Map<string, Entry>()

  async head(key: string): Promise<ObjectMeta | null> {
    return this.entries.get(key)?.meta ?? null
  }

  async putIfAbsent(key: string, bytes: AsyncIterable<Uint8Array>, meta: PutMeta): Promise<PutResult> {
    const existing = this.entries.get(key)
    if (existing) return { meta: existing.meta, alreadyExisted: true }
    const buffer = await asyncIterableToUint8Array(bytes)
    if (buffer.byteLength !== meta.compressedSize) {
      throw new Error(
        `MemoryObjectStore.putIfAbsent: byte size mismatch (declared ${meta.compressedSize}, received ${buffer.byteLength})`,
      )
    }
    const stored: Entry = { bytes: buffer, meta: { ...meta, storageKey: key } }
    this.entries.set(key, stored)
    return { meta: stored.meta, alreadyExisted: false }
  }

  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    const entry = this.entries.get(key)
    if (!entry) throw new Error(`MemoryObjectStore.get: object not found at ${key}`)
    return uint8ArrayToWebStream(entry.bytes)
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key)
  }

  /** Number of stored objects (test helper). */
  size(): number {
    return this.entries.size
  }
}
