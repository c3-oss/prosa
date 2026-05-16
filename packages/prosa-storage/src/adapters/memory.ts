import {
  type ObjectMeta,
  PUT_PREVERIFIED_BYTES,
  type PutMeta,
  type PutResult,
  type RemoteObjectStore,
  asyncIterableToUint8Array,
  uint8ArrayToWebStream,
} from '../types.js'
import { assertNoConflict, verifyBytes } from '../verify.js'

type Entry = { bytes: Uint8Array; meta: ObjectMeta }
type LockState = { tail: Promise<void> }

/**
 * In-process object store. Useful for tests; the spec also designates it as
 * the only acceptable backend for the test suite.
 */
export class MemoryObjectStore implements RemoteObjectStore {
  private readonly entries = new Map<string, Entry>()
  private readonly locks = new Map<string, LockState>()

  async head(key: string): Promise<ObjectMeta | null> {
    return this.entries.get(key)?.meta ?? null
  }

  async putIfAbsent(key: string, bytes: AsyncIterable<Uint8Array>, meta: PutMeta): Promise<PutResult> {
    return this.putLocked(key, bytes, meta, { verify: true })
  }

  async [PUT_PREVERIFIED_BYTES](key: string, bytes: AsyncIterable<Uint8Array>, meta: PutMeta): Promise<PutResult> {
    return this.putLocked(key, bytes, meta, { verify: false })
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

  private async putLocked(
    key: string,
    bytes: AsyncIterable<Uint8Array>,
    meta: PutMeta,
    opts: { verify: boolean },
  ): Promise<PutResult> {
    return this.withKeyLock(key, async () => {
      const existing = this.entries.get(key)
      if (existing) {
        assertNoConflict(existing.meta, meta)
        return { meta: existing.meta, alreadyExisted: true }
      }
      const buffer = await asyncIterableToUint8Array(bytes)
      if (opts.verify) verifyBytes(buffer, meta)
      const stored: Entry = { bytes: buffer, meta: { ...meta, storageKey: key } }
      this.entries.set(key, stored)
      return { meta: stored.meta, alreadyExisted: false }
    })
  }

  private async withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const state = this.locks.get(key) ?? { tail: Promise.resolve() }
    this.locks.set(key, state)
    const previous = state.tail
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    state.tail = current
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (state.tail === current) {
        this.locks.delete(key)
      }
    }
  }
}
