import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { blake3Hex } from '../../src/core/cas/hash.js'
import { getBytes, getJson, putBytes, putJson, putText } from '../../src/core/cas/index.js'
import { createTempBundle } from '../helpers/tmp-bundle.js'

describe('CAS', () => {
  it('roundtrips bytes and is idempotent on identical input', async () => {
    const t = await createTempBundle()
    try {
      const data = Buffer.from('hello prosa', 'utf8')
      const id1 = await putBytes(t.bundle, data)
      const id2 = await putBytes(t.bundle, data)
      expect(id1).toBe(id2)
      expect(id1.startsWith('blake3:')).toBe(true)

      const back = await getBytes(t.bundle, id1)
      expect(Buffer.from(back).equals(data)).toBe(true)

      const objectsRow = t.bundle.db
        .prepare<[string], { count: number }>(`SELECT count(*) AS count FROM objects WHERE object_id = ?`)
        .get(id1)
      expect(objectsRow?.count).toBe(1)
    } finally {
      await t.cleanup()
    }
  })

  it('compresses larger payloads with zstd', async () => {
    const t = await createTempBundle()
    try {
      const big = Buffer.from('a'.repeat(10_000), 'utf8')
      const id = await putBytes(t.bundle, big)
      const meta = t.bundle.db
        .prepare<[string], { compression: string; compressed_size_bytes: number }>(
          `SELECT compression, compressed_size_bytes FROM objects WHERE object_id = ?`,
        )
        .get(id)
      expect(meta?.compression).toBe('zstd')
      expect(meta?.compressed_size_bytes).toBeLessThan(10_000)

      const back = await getBytes(t.bundle, id)
      expect(back.byteLength).toBe(10_000)
    } finally {
      await t.cleanup()
    }
  })

  it('persists transport hashes for stored bytes', async () => {
    const t = await createTempBundle()
    try {
      const small = Buffer.from('small payload', 'utf8')
      const smallId = await putBytes(t.bundle, small)
      const smallMeta = t.bundle.db
        .prepare<[string], { hash: string; transport_hash: string | null; storage_path: string; compression: string }>(
          `SELECT hash, transport_hash, storage_path, compression FROM objects WHERE object_id = ?`,
        )
        .get(smallId)
      expect(smallMeta?.compression).toBe('none')
      expect(smallMeta?.transport_hash).toBe(smallMeta?.hash)

      const big = Buffer.from('transport-hash '.repeat(1_000), 'utf8')
      const bigId = await putBytes(t.bundle, big)
      const bigMeta = t.bundle.db
        .prepare<[string], { hash: string; transport_hash: string | null; storage_path: string; compression: string }>(
          `SELECT hash, transport_hash, storage_path, compression FROM objects WHERE object_id = ?`,
        )
        .get(bigId)
      expect(bigMeta?.compression).toBe('zstd')
      const stored = await readFile(path.join(t.path, bigMeta?.storage_path ?? ''))
      expect(bigMeta?.transport_hash).toBe(blake3Hex(stored))
    } finally {
      await t.cleanup()
    }
  })

  it('stores text and json with correct mime types', async () => {
    const t = await createTempBundle()
    try {
      const textId = await putText(t.bundle, 'hello')
      const jsonId = await putJson(t.bundle, { foo: 1, bar: ['a', 'b'] })

      const json = await getJson<{ foo: number; bar: string[] }>(t.bundle, jsonId)
      expect(json.foo).toBe(1)
      expect(json.bar).toEqual(['a', 'b'])

      expect(textId).not.toBe(jsonId)
    } finally {
      await t.cleanup()
    }
  })
})
