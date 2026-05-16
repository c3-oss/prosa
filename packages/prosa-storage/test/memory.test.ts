import { describe, expect, it } from 'vitest'
import { MemoryObjectStore } from '../src/adapters/memory.js'
import { casObjectKey } from '../src/types.js'
import { ObjectVerificationError, computeHashHex } from '../src/verify.js'

async function* fromBuffer(buf: Uint8Array): AsyncIterable<Uint8Array> {
  yield buf
}

function trackedBytes(buf: Uint8Array, tracker: { consumed: number }): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      tracker.consumed += 1
      yield buf
    },
  }
}

async function consume(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.byteLength
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

describe('MemoryObjectStore', () => {
  it('puts, heads, and gets bytes when the hash matches', async () => {
    const store = new MemoryObjectStore()
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const hash = computeHashHex(bytes, 'blake3')
    const key = casObjectKey(hash, 'prosa/')

    expect(await store.head(key)).toBeNull()
    const put = await store.putIfAbsent(key, fromBuffer(bytes), {
      hash,
      hashAlgorithm: 'blake3',
      uncompressedSize: 5,
      compressedSize: 5,
      contentType: 'application/octet-stream',
    })
    expect(put.alreadyExisted).toBe(false)
    expect(put.meta.storageKey).toBe(key)

    const meta = await store.head(key)
    expect(meta?.hash).toBe(hash)

    const stream = await store.get(key)
    const out = await consume(stream)
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5])
  })

  it('treats repeat putIfAbsent with matching metadata as a no-op', async () => {
    const store = new MemoryObjectStore()
    const bytes = new Uint8Array([9])
    const hash = computeHashHex(bytes, 'blake3')
    const key = 'objects/test'
    await store.putIfAbsent(key, fromBuffer(bytes), {
      hash,
      hashAlgorithm: 'blake3',
      uncompressedSize: 1,
      compressedSize: 1,
    })
    const second = await store.putIfAbsent(key, fromBuffer(new Uint8Array([0])), {
      hash,
      hashAlgorithm: 'blake3',
      uncompressedSize: 1,
      compressedSize: 1,
    })
    expect(second.alreadyExisted).toBe(true)
    expect(store.size()).toBe(1)
    const stream = await store.get(key)
    const out = await consume(stream)
    // The original bytes are preserved — putIfAbsent does not overwrite.
    expect(Array.from(out)).toEqual([9])
  })

  it('rejects a repeat putIfAbsent that declares conflicting hash', async () => {
    const store = new MemoryObjectStore()
    const bytes = new Uint8Array([42])
    const hash = computeHashHex(bytes, 'blake3')
    await store.putIfAbsent('objects/conflict', fromBuffer(bytes), {
      hash,
      hashAlgorithm: 'blake3',
      uncompressedSize: 1,
      compressedSize: 1,
    })
    await expect(
      store.putIfAbsent('objects/conflict', fromBuffer(bytes), {
        hash: 'deadbeef',
        hashAlgorithm: 'blake3',
        uncompressedSize: 1,
        compressedSize: 1,
      }),
    ).rejects.toThrow(ObjectVerificationError)
  })

  it('rejects size mismatch declarations', async () => {
    const store = new MemoryObjectStore()
    await expect(
      store.putIfAbsent('k', fromBuffer(new Uint8Array([1, 2])), {
        hash: '00',
        hashAlgorithm: 'blake3',
        uncompressedSize: 2,
        compressedSize: 99,
      }),
    ).rejects.toThrow(/size mismatch/)
  })

  it('rejects bytes whose hash does not match the declaration', async () => {
    const store = new MemoryObjectStore()
    await expect(
      store.putIfAbsent('k', fromBuffer(new Uint8Array([1, 2, 3])), {
        hash: 'deadbeef',
        hashAlgorithm: 'blake3',
        uncompressedSize: 3,
        compressedSize: 3,
      }),
    ).rejects.toThrow(/blake3 mismatch/)
  })

  it('serializes concurrent identical putIfAbsent calls for the same key', async () => {
    const store = new MemoryObjectStore()
    const bytes = new Uint8Array([1, 1, 2, 3, 5, 8])
    const hash = computeHashHex(bytes, 'blake3')
    const first = { consumed: 0 }
    const second = { consumed: 0 }
    const meta = {
      hash,
      hashAlgorithm: 'blake3' as const,
      uncompressedSize: bytes.byteLength,
      compressedSize: bytes.byteLength,
    }

    const [a, b] = await Promise.all([
      store.putIfAbsent('objects/race', trackedBytes(bytes, first), meta),
      store.putIfAbsent('objects/race', trackedBytes(bytes, second), meta),
    ])

    expect([a.alreadyExisted, b.alreadyExisted].sort()).toEqual([false, true])
    expect(first.consumed + second.consumed).toBe(1)
    expect(store.size()).toBe(1)
    expect(Array.from(await consume(await store.get('objects/race')))).toEqual(Array.from(bytes))
  })

  it('rejects concurrent conflicting putIfAbsent calls without overwriting bytes', async () => {
    const store = new MemoryObjectStore()
    const stored = new Uint8Array([9, 9, 9])
    const conflicting = new Uint8Array([7, 7, 7])
    const storedHash = computeHashHex(stored, 'blake3')
    const conflictHash = computeHashHex(conflicting, 'blake3')
    const conflictTracker = { consumed: 0 }

    const first = store.putIfAbsent('objects/conflicting-race', fromBuffer(stored), {
      hash: storedHash,
      hashAlgorithm: 'blake3',
      uncompressedSize: stored.byteLength,
      compressedSize: stored.byteLength,
    })
    const second = store.putIfAbsent('objects/conflicting-race', trackedBytes(conflicting, conflictTracker), {
      hash: conflictHash,
      hashAlgorithm: 'blake3',
      uncompressedSize: conflicting.byteLength,
      compressedSize: conflicting.byteLength,
    })

    await expect(second).rejects.toThrow(ObjectVerificationError)
    await expect(first).resolves.toMatchObject({ alreadyExisted: false })
    expect(conflictTracker.consumed).toBe(0)
    expect(Array.from(await consume(await store.get('objects/conflicting-race')))).toEqual(Array.from(stored))
  })
})
