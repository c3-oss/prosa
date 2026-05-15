import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FsObjectStore } from '../src/adapters/fs.js'
import { ObjectVerificationError, computeHashHex } from '../src/verify.js'

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
})
