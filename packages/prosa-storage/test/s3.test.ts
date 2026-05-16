import { Readable } from 'node:stream'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'
import { S3ObjectStore } from '../src/adapters/s3.js'
import type { PutMeta } from '../src/types.js'
import { ObjectVerificationError, computeHashHex } from '../src/verify.js'

async function* fromBuffer(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes
}

async function consume(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    total += value.byteLength
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

type Command = HeadObjectCommand | PutObjectCommand | GetObjectCommand | DeleteObjectCommand

class FakeS3Client {
  readonly commands: Command[] = []
  nextHead: unknown = { Metadata: {}, ContentLength: 0 }
  nextGet: unknown = { Body: Readable.from([Buffer.from('ok')]) }
  headResponses: unknown[] = []
  nextPut: unknown = {}

  async send(command: Command): Promise<unknown> {
    this.commands.push(command)
    if (command instanceof HeadObjectCommand) {
      const response = this.headResponses.length > 0 ? this.headResponses.shift() : this.nextHead
      if (response instanceof Error) throw response
      return response
    }
    if (command instanceof PutObjectCommand) {
      if (this.nextPut instanceof Error) throw this.nextPut
      return this.nextPut
    }
    if (command instanceof GetObjectCommand) return this.nextGet
    if (command instanceof DeleteObjectCommand) return {}
    throw new Error('unexpected command')
  }
}

function notFound(name: 'NotFound' | 'NoSuchKey'): Error {
  const err = new Error(name)
  err.name = name
  return err
}

function preconditionFailed(): Error {
  const err = new Error('PreconditionFailed') as Error & { $metadata: { httpStatusCode: number } }
  err.name = 'PreconditionFailed'
  err.$metadata = { httpStatusCode: 412 }
  return err
}

function s3HeadFor(meta: PutMeta): unknown {
  return {
    Metadata: {
      'prosa-hash': meta.hash,
      'prosa-hash-algorithm': meta.hashAlgorithm,
      'prosa-uncompressed-size': String(meta.uncompressedSize),
      'prosa-compressed-size': String(meta.compressedSize),
      ...(meta.contentType ? { 'prosa-content-type': meta.contentType } : {}),
    },
  }
}

function metaFor(bytes: Uint8Array, overrides: Partial<PutMeta> = {}): PutMeta {
  return {
    hash: computeHashHex(bytes, 'blake3'),
    hashAlgorithm: 'blake3',
    uncompressedSize: bytes.byteLength,
    compressedSize: bytes.byteLength,
    contentType: 'application/octet-stream',
    ...overrides,
  }
}

describe('S3ObjectStore', () => {
  it('maps S3 metadata from head and treats not found errors as missing objects', async () => {
    const client = new FakeS3Client()
    client.nextHead = {
      Metadata: {
        'prosa-hash': 'abc',
        'prosa-hash-algorithm': 'sha256',
        'prosa-uncompressed-size': '10',
        'prosa-compressed-size': '7',
        'prosa-content-type': 'application/zstd',
      },
    }
    const store = new S3ObjectStore({ bucket: 'bucket', client: client as unknown as S3Client })

    expect(await store.head('objects/key')).toEqual({
      hash: 'abc',
      hashAlgorithm: 'sha256',
      uncompressedSize: 10,
      compressedSize: 7,
      contentType: 'application/zstd',
      storageKey: 'objects/key',
    })

    client.nextHead = notFound('NoSuchKey')
    expect(await store.head('missing')).toBeNull()

    client.nextHead = new Error('boom')
    await expect(store.head('error')).rejects.toThrow('boom')
  })

  it('puts a verified object with metadata and conditional write headers', async () => {
    const client = new FakeS3Client()
    client.nextHead = notFound('NotFound')
    const store = new S3ObjectStore({ bucket: 'bucket', client: client as unknown as S3Client })
    const bytes = new Uint8Array([1, 2, 3])
    const meta = metaFor(bytes, { contentType: 'application/prosa' })

    const result = await store.putIfAbsent('objects/key', fromBuffer(bytes), meta)

    expect(result).toEqual({ meta: { ...meta, storageKey: 'objects/key' }, alreadyExisted: false })
    const put = client.commands.find((command) => command instanceof PutObjectCommand) as PutObjectCommand
    expect(put.input).toMatchObject({
      Bucket: 'bucket',
      Key: 'objects/key',
      ContentType: 'application/prosa',
      IfNoneMatch: '*',
      Metadata: {
        'prosa-hash': meta.hash,
        'prosa-hash-algorithm': 'blake3',
        'prosa-uncompressed-size': '3',
        'prosa-compressed-size': '3',
        'prosa-content-type': 'application/prosa',
      },
    })
  })

  it('returns existing metadata without consuming upload bytes', async () => {
    const client = new FakeS3Client()
    client.nextHead = {
      Metadata: {
        'prosa-hash': 'abc',
        'prosa-hash-algorithm': 'blake3',
        'prosa-uncompressed-size': '1',
        'prosa-compressed-size': '1',
      },
    }
    const store = new S3ObjectStore({ bucket: 'bucket', client: client as unknown as S3Client })
    let consumed = false
    async function* bytes(): AsyncIterable<Uint8Array> {
      consumed = true
      yield new Uint8Array([1])
    }

    const result = await store.putIfAbsent('objects/key', bytes(), {
      hash: 'abc',
      hashAlgorithm: 'blake3',
      uncompressedSize: 1,
      compressedSize: 1,
    })

    expect(result.alreadyExisted).toBe(true)
    expect(consumed).toBe(false)
    expect(client.commands.some((command) => command instanceof PutObjectCommand)).toBe(false)
  })

  it('treats a conditional write race with compatible metadata as already existing', async () => {
    const client = new FakeS3Client()
    const bytes = new Uint8Array([2, 4, 6])
    const meta = metaFor(bytes)
    client.headResponses = [notFound('NotFound'), s3HeadFor(meta)]
    client.nextPut = preconditionFailed()
    const store = new S3ObjectStore({ bucket: 'bucket', client: client as unknown as S3Client })

    const result = await store.putIfAbsent('objects/key', fromBuffer(bytes), meta)

    expect(result).toEqual({ meta: { ...meta, storageKey: 'objects/key' }, alreadyExisted: true })
    expect(client.commands.filter((command) => command instanceof HeadObjectCommand)).toHaveLength(2)
    expect(client.commands.filter((command) => command instanceof PutObjectCommand)).toHaveLength(1)
  })

  it('rejects a conditional write race when the winner metadata conflicts', async () => {
    const client = new FakeS3Client()
    const bytes = new Uint8Array([2, 4, 6])
    const meta = metaFor(bytes)
    client.headResponses = [
      notFound('NotFound'),
      s3HeadFor(metaFor(new Uint8Array([9, 9, 9]), { uncompressedSize: 3, compressedSize: 3 })),
    ]
    client.nextPut = preconditionFailed()
    const store = new S3ObjectStore({ bucket: 'bucket', client: client as unknown as S3Client })

    await expect(store.putIfAbsent('objects/key', fromBuffer(bytes), meta)).rejects.toThrow(ObjectVerificationError)
  })

  it('reads web streams, async iterable bodies, and rejects empty get bodies', async () => {
    const client = new FakeS3Client()
    const store = new S3ObjectStore({ bucket: 'bucket', client: client as unknown as S3Client })

    client.nextGet = { Body: new ReadableStream({ start: (controller) => controller.close() }) }
    expect(Array.from(await consume(await store.get('web')))).toEqual([])

    client.nextGet = { Body: Readable.from([Buffer.from([7, 8])]) }
    expect(Array.from(await consume(await store.get('node')))).toEqual([7, 8])

    client.nextGet = {}
    await expect(store.get('missing-body')).rejects.toThrow(/empty response body/)
  })

  it('reads byte ranges with an S3 Range header', async () => {
    const client = new FakeS3Client()
    const store = new S3ObjectStore({ bucket: 'bucket', client: client as unknown as S3Client })
    client.nextGet = { Body: Readable.from([Buffer.from([2, 3, 4])]) }

    expect(Array.from(await consume(await store.getRange('objects/pack', 2, 3)))).toEqual([2, 3, 4])

    const command = client.commands.at(-1) as GetObjectCommand
    expect(command).toBeInstanceOf(GetObjectCommand)
    expect(command.input).toMatchObject({
      Bucket: 'bucket',
      Key: 'objects/pack',
      Range: 'bytes=2-4',
    })
  })

  it('deletes the configured bucket/key pair', async () => {
    const client = new FakeS3Client()
    const store = new S3ObjectStore({ bucket: 'bucket', client: client as unknown as S3Client })

    await store.delete('objects/key')

    const command = client.commands.at(-1) as DeleteObjectCommand
    expect(command).toBeInstanceOf(DeleteObjectCommand)
    expect(command.input).toMatchObject({ Bucket: 'bucket', Key: 'objects/key' })
  })
})
