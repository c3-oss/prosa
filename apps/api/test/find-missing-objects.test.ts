import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import type { ObjectManifestEntry } from '@c3-oss/prosa-sync'
import { describe, expect, it, vi } from 'vitest'
import type { RawExec } from '../src/db.js'
import { findMissingObjectIds } from '../src/trpc/routers/sync/manifest.js'

function makeEntry(seed: number): ObjectManifestEntry {
  const hash = String(seed).padStart(64, '0')
  return {
    objectId: `blake3:${hash}`,
    hash,
    hashAlgorithm: 'blake3',
    uncompressedSize: 4,
    compressedSize: 4,
    compression: 'none',
  }
}

function makeEntries(count: number): ObjectManifestEntry[] {
  return Array.from({ length: count }, (_, index) => makeEntry(index))
}

type HeadResult = Awaited<ReturnType<RemoteObjectStore['head']>>

function nullObjectStore(): RemoteObjectStore {
  return {
    head: vi.fn().mockResolvedValue(null),
    get: vi.fn(),
    getRange: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as RemoteObjectStore
}

function compatibleLocationRow(obj: ObjectManifestEntry) {
  return {
    object_id: obj.objectId,
    hash: obj.hash,
    hash_algorithm: 'blake3',
    compression: obj.compression,
    uncompressed_size: obj.uncompressedSize,
    compressed_size: obj.compressedSize,
    legacy_storage_key: `objects/${obj.hash}`,
    location_type: null,
    location_storage_key: null,
    blob_storage_key: null,
    blob_hash: null,
    blob_hash_algorithm: null,
    blob_byte_size: null,
    byte_offset: null,
    byte_length: null,
  }
}

function compatibleHead(obj: ObjectManifestEntry): NonNullable<HeadResult> {
  return {
    storageKey: `objects/${obj.hash}`,
    hash: obj.transportHash ?? obj.hash,
    hashAlgorithm: 'blake3',
    compressedSize: obj.compressedSize,
    uncompressedSize: obj.uncompressedSize,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(message)
}

const TENANT_ID = 'tenant-abc'

describe('findMissingObjectIds', () => {
  it('returns [] immediately for an empty objects list without any DB query', async () => {
    const rawExec = vi.fn() as unknown as RawExec

    const result = await findMissingObjectIds({
      rawExec,
      objectStore: nullObjectStore(),
      objects: [],
      tenantId: TENANT_ID,
    })

    expect(result).toEqual([])
    expect(rawExec).not.toHaveBeenCalled()
  })

  it('returns all ids in manifest order when no objects are materialized', async () => {
    const objects = makeEntries(100)
    const rawExec = vi.fn(async (_sql: string, params?: unknown[]) => {
      expect(params).toEqual([TENANT_ID, objects.map((object) => object.objectId)])
      return []
    }) as unknown as RawExec
    const objectStore = nullObjectStore()

    const result = await findMissingObjectIds({
      rawExec,
      objectStore,
      objects,
      tenantId: TENANT_ID,
    })

    expect(result).toEqual(objects.map((obj) => obj.objectId))
    expect(rawExec).toHaveBeenCalledTimes(1)
    expect(vi.mocked(objectStore.head)).not.toHaveBeenCalled()
  })

  it('returns only objects without compatible bytes while preserving manifest order', async () => {
    const objects = makeEntries(6)
    const presentObjects = [objects[1]!, objects[4]!]
    const presentIds = new Set(presentObjects.map((object) => object.objectId))
    const objectStore: RemoteObjectStore = {
      head: vi.fn(async (key: string) => {
        const matchingObj = presentObjects.find((object) => key.includes(object.hash))
        return matchingObj ? compatibleHead(matchingObj) : null
      }),
      get: vi.fn(),
      getRange: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as RemoteObjectStore
    const rawExec = vi.fn(async () => objects.map(compatibleLocationRow)) as unknown as RawExec

    const result = await findMissingObjectIds({
      rawExec,
      objectStore,
      objects,
      tenantId: TENANT_ID,
    })

    expect(result).toEqual(
      objects.filter((object) => !presentIds.has(object.objectId)).map((object) => object.objectId),
    )
    expect(rawExec).toHaveBeenCalledTimes(1)
    expect(vi.mocked(objectStore.head)).toHaveBeenCalledTimes(objects.length)
  })

  it('keeps missing ids in manifest order when concurrent head checks finish out of order', async () => {
    const objects = makeEntries(5)
    const presentIds = new Set([objects[1]!.objectId, objects[3]!.objectId])
    const headResults = new Map(objects.map((obj) => [obj.objectId, deferred<HeadResult>()]))
    const objectStore: RemoteObjectStore = {
      head: vi.fn((key: string) => {
        const matchingObj = objects.find((object) => key.includes(object.hash))
        if (!matchingObj) throw new Error(`Unexpected storage key: ${key}`)
        return headResults.get(matchingObj.objectId)!.promise
      }),
      get: vi.fn(),
      getRange: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as RemoteObjectStore
    const rawExec = vi.fn(async () => objects.map(compatibleLocationRow)) as unknown as RawExec

    const resultPromise = findMissingObjectIds({
      rawExec,
      objectStore,
      objects,
      tenantId: TENANT_ID,
    })

    await waitForCondition(
      () => vi.mocked(objectStore.head).mock.calls.length === objects.length,
      'Expected all bytes checks to reach objectStore.head',
    )
    for (const obj of [...objects].reverse()) {
      headResults.get(obj.objectId)!.resolve(presentIds.has(obj.objectId) ? compatibleHead(obj) : null)
    }

    await expect(resultPromise).resolves.toEqual([objects[0]!.objectId, objects[2]!.objectId, objects[4]!.objectId])
    expect(rawExec).toHaveBeenCalledTimes(1)
  })
})
