import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FsObjectStore } from '../src/adapters/fs.js'
import { MemoryObjectStore } from '../src/adapters/memory.js'
import { S3ObjectStore } from '../src/adapters/s3.js'
import { createObjectStoreFromConfig } from '../src/factory.js'
import {
  artifactKey,
  asyncIterableToUint8Array,
  casObjectKey,
  exportKey,
  objectPackStorageKey,
  rawSourceKey,
} from '../src/types.js'
import { ObjectVerificationError, assertNoConflict, computeHashHex } from '../src/verify.js'

async function* fromChunks(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk
}

describe('object key helpers', () => {
  it('builds deterministic prefixed storage keys with or without a trailing slash', () => {
    const hash = 'abcdef123456'

    expect(casObjectKey(hash, 'prosa')).toBe('prosa/objects/blake3/ab/cd/abcdef123456.zst')
    expect(rawSourceKey('tenant-1', 'source-1', 'prosa/')).toBe('prosa/raw/sources/tenant-1/source-1.zst')
    expect(objectPackStorageKey({ tenantId: 'tenant-1', batchId: 'batch-1', packHash: hash })).toBe(
      'object-packs/tenant-1/batch-1/abcdef123456.pack',
    )
    expect(artifactKey('tenant-1', 'artifact-1', 'prosa')).toBe('prosa/artifacts/tenant-1/artifact-1')
    expect(exportKey('tenant-1', 'snapshot-1', 'sessions.parquet', 'prosa/')).toBe(
      'prosa/exports/parquet/tenant-1/snapshot-1/sessions.parquet',
    )
  })

  it('collects async iterable chunks into a single byte array', async () => {
    const bytes = await asyncIterableToUint8Array(fromChunks(new Uint8Array([1, 2]), new Uint8Array([3])))

    expect(Array.from(bytes)).toEqual([1, 2, 3])
  })
})

describe('createObjectStoreFromConfig', () => {
  it('creates the configured memory, fs, and s3 adapters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prosa-store-factory-'))
    try {
      expect(createObjectStoreFromConfig({ driver: 'memory', prefix: 'p' })).toBeInstanceOf(MemoryObjectStore)
      expect(createObjectStoreFromConfig({ driver: 'fs', root, prefix: 'p' })).toBeInstanceOf(FsObjectStore)
      expect(
        createObjectStoreFromConfig({
          driver: 's3',
          bucket: 'bucket',
          prefix: 'p',
          region: 'us-east-1',
          endpoint: 'http://localhost:9000',
          forcePathStyle: true,
        }),
      ).toBeInstanceOf(S3ObjectStore)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('object verification helpers', () => {
  it('computes sha256 hashes and rejects every conflicting metadata field', () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(computeHashHex(bytes, 'sha256')).toMatch(/^[0-9a-f]{64}$/)

    const existing = {
      hash: 'a',
      hashAlgorithm: 'blake3' as const,
      uncompressedSize: 3,
      compressedSize: 3,
      storageKey: 'key',
    }

    expect(() => assertNoConflict(existing, { ...existing, storageKey: undefined as never, hash: 'b' })).toThrow(
      ObjectVerificationError,
    )
    expect(() =>
      assertNoConflict(existing, { ...existing, storageKey: undefined as never, hashAlgorithm: 'sha256' }),
    ).toThrow(ObjectVerificationError)
    expect(() =>
      assertNoConflict(existing, { ...existing, storageKey: undefined as never, compressedSize: 4 }),
    ).toThrow(ObjectVerificationError)
    expect(() =>
      assertNoConflict(existing, { ...existing, storageKey: undefined as never, uncompressedSize: 4 }),
    ).toThrow(ObjectVerificationError)
  })
})
