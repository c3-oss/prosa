import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FsObjectStore } from '../src/adapters/fs.js'
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

describe('FsObjectStore', () => {
  let root: string
  let store: FsObjectStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'prosa-fs-store-'))
    store = new FsObjectStore(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('round-trips bytes through put/head/get when the hash matches', async () => {
    const bytes = new Uint8Array([4, 8, 15, 16, 23, 42])
    const hash = computeHashHex(bytes, 'blake3')
    const put = await store.putIfAbsent(
      `objects/blake3/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.zst`,
      fromBuffer(bytes),
      {
        hash,
        hashAlgorithm: 'blake3',
        uncompressedSize: 6,
        compressedSize: 6,
      },
    )
    expect(put.alreadyExisted).toBe(false)

    const meta = await store.head(`objects/blake3/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.zst`)
    expect(meta?.hash).toBe(hash)

    const out = await consume(await store.get(`objects/blake3/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.zst`))
    expect(Array.from(out)).toEqual([4, 8, 15, 16, 23, 42])
  })

  it('rejects a conflicting repeat put on the same key', async () => {
    const bytes = new Uint8Array([1])
    const hash = computeHashHex(bytes, 'blake3')
    await store.putIfAbsent('objects/test', fromBuffer(bytes), {
      hash,
      hashAlgorithm: 'blake3',
      uncompressedSize: 1,
      compressedSize: 1,
    })
    await expect(
      store.putIfAbsent('objects/test', fromBuffer(bytes), {
        hash: 'deadbeef',
        hashAlgorithm: 'blake3',
        uncompressedSize: 1,
        compressedSize: 1,
      }),
    ).rejects.toThrow(ObjectVerificationError)
  })

  it('refuses path traversal', async () => {
    const bytes = new Uint8Array([1])
    const hash = computeHashHex(bytes, 'blake3')
    await expect(
      store.putIfAbsent('../escape', fromBuffer(bytes), {
        hash,
        hashAlgorithm: 'blake3',
        uncompressedSize: 1,
        compressedSize: 1,
      }),
    ).rejects.toThrow(/path traversal/)
  })

  it('returns null on missing head and deletes idempotently', async () => {
    expect(await store.head('missing/key')).toBeNull()
    await store.delete('missing/key')
    await store.delete('missing/key')
  })

  it('serializes concurrent identical writes across store instances', async () => {
    const other = new FsObjectStore(root)
    const bytes = new Uint8Array([3, 1, 4, 1, 5, 9])
    const hash = computeHashHex(bytes, 'blake3')
    const key = 'objects/fs-race'
    const first = { consumed: 0 }
    const second = { consumed: 0 }
    const meta = {
      hash,
      hashAlgorithm: 'blake3' as const,
      uncompressedSize: bytes.byteLength,
      compressedSize: bytes.byteLength,
    }

    const [a, b] = await Promise.all([
      store.putIfAbsent(key, trackedBytes(bytes, first), meta),
      other.putIfAbsent(key, trackedBytes(bytes, second), meta),
    ])

    expect([a.alreadyExisted, b.alreadyExisted].sort()).toEqual([false, true])
    expect(first.consumed + second.consumed).toBe(1)
    expect(Array.from(await consume(await store.get(key)))).toEqual(Array.from(bytes))
  })

  it('rejects concurrent conflicting writes without replacing the winner', async () => {
    const bytes = new Uint8Array([6, 2, 6])
    const conflicting = new Uint8Array([5, 3, 5])
    const hash = computeHashHex(bytes, 'blake3')
    const conflictHash = computeHashHex(conflicting, 'blake3')
    const trackers = [{ consumed: 0 }, { consumed: 0 }]
    const key = 'objects/fs-conflicting-race'

    const first = store.putIfAbsent(key, trackedBytes(bytes, trackers[0]!), {
      hash,
      hashAlgorithm: 'blake3',
      uncompressedSize: bytes.byteLength,
      compressedSize: bytes.byteLength,
    })
    const second = store.putIfAbsent(key, trackedBytes(conflicting, trackers[1]!), {
      hash: conflictHash,
      hashAlgorithm: 'blake3',
      uncompressedSize: conflicting.byteLength,
      compressedSize: conflicting.byteLength,
    })

    const results = await Promise.allSettled([first, second])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(fulfilled[0]).toMatchObject({ value: { alreadyExisted: false } })
    expect(rejected[0]).toMatchObject({ reason: expect.any(ObjectVerificationError) })
    expect(trackers[0]!.consumed + trackers[1]!.consumed).toBe(1)
    const winner = trackers[0]!.consumed === 1 ? bytes : conflicting
    expect(Array.from(await consume(await store.get(key)))).toEqual(Array.from(winner))
  })
})
