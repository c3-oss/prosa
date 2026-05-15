import { describe, expect, it } from 'vitest'
import { MemoryObjectStore } from '../src/adapters/memory.js'
import { casObjectKey } from '../src/types.js'

async function* fromBuffer(buf: Uint8Array): AsyncIterable<Uint8Array> {
  yield buf
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
  it('puts, heads, and gets bytes', async () => {
    const store = new MemoryObjectStore()
    const key = casObjectKey('abcdef0123456789', 'prosa/')
    const bytes = new Uint8Array([1, 2, 3, 4, 5])

    expect(await store.head(key)).toBeNull()
    const put = await store.putIfAbsent(key, fromBuffer(bytes), {
      hash: 'abcdef0123456789',
      hashAlgorithm: 'blake3',
      uncompressedSize: 5,
      compressedSize: 5,
      contentType: 'application/octet-stream',
    })
    expect(put.alreadyExisted).toBe(false)
    expect(put.meta.storageKey).toBe(key)

    const meta = await store.head(key)
    expect(meta?.hash).toBe('abcdef0123456789')

    const stream = await store.get(key)
    const out = await consume(stream)
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5])
  })

  it('treats repeat putIfAbsent as a no-op', async () => {
    const store = new MemoryObjectStore()
    const key = 'objects/test'
    const bytes = new Uint8Array([9])
    await store.putIfAbsent(key, fromBuffer(bytes), {
      hash: 'h',
      hashAlgorithm: 'blake3',
      uncompressedSize: 1,
      compressedSize: 1,
    })
    const second = await store.putIfAbsent(key, fromBuffer(new Uint8Array([0])), {
      hash: 'h',
      hashAlgorithm: 'blake3',
      uncompressedSize: 1,
      compressedSize: 1,
    })
    expect(second.alreadyExisted).toBe(true)
    expect(store.size()).toBe(1)
    const stream = await store.get(key)
    const out = await consume(stream)
    expect(Array.from(out)).toEqual([9])
  })

  it('rejects size mismatch', async () => {
    const store = new MemoryObjectStore()
    await expect(
      store.putIfAbsent('k', fromBuffer(new Uint8Array([1, 2])), {
        hash: 'h',
        hashAlgorithm: 'blake3',
        uncompressedSize: 2,
        compressedSize: 99,
      }),
    ).rejects.toThrow(/size mismatch/)
  })
})
