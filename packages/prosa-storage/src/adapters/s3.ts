import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
  S3Client as S3ClientCtor,
} from '@aws-sdk/client-s3'
import {
  type ObjectMeta,
  type PutMeta,
  type PutResult,
  type RemoteObjectStore,
  asyncIterableToUint8Array,
} from '../types.js'
import { assertNoConflict, verifyBytes } from '../verify.js'

export type S3ObjectStoreOptions = {
  bucket: string
  client?: S3Client
  endpoint?: string
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  /**
   * Optional key prefix scoped to this adapter. Keys passed to the store are
   * sent through as-is — the prefix is shared with helpers in `types.ts`.
   */
  forcePathStyle?: boolean
}

const META_FIELDS = {
  hash: 'prosa-hash',
  hashAlgorithm: 'prosa-hash-algorithm',
  uncompressedSize: 'prosa-uncompressed-size',
  compressedSize: 'prosa-compressed-size',
  contentType: 'prosa-content-type',
} as const

/**
 * S3-compatible object store. Production target plus self-host deployments
 * that point at MinIO, Cloudflare R2, or similar.
 */
export class S3ObjectStore implements RemoteObjectStore {
  private readonly client: S3Client
  private readonly bucket: string

  constructor(opts: S3ObjectStoreOptions) {
    this.bucket = opts.bucket
    if (opts.client) {
      this.client = opts.client
    } else {
      const credentials =
        opts.accessKeyId && opts.secretAccessKey
          ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey }
          : undefined
      this.client = new S3ClientCtor({
        region: opts.region ?? 'us-east-1',
        ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
        ...(opts.forcePathStyle ? { forcePathStyle: true } : {}),
        ...(credentials ? { credentials } : {}),
      })
    }
  }

  async head(key: string): Promise<ObjectMeta | null> {
    try {
      const response = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      const md = response.Metadata ?? {}
      const hash = md[META_FIELDS.hash]
      if (!hash) return null
      const meta: ObjectMeta = {
        hash,
        hashAlgorithm: (md[META_FIELDS.hashAlgorithm] as ObjectMeta['hashAlgorithm']) ?? 'blake3',
        uncompressedSize: Number(md[META_FIELDS.uncompressedSize] ?? 0),
        compressedSize: Number(md[META_FIELDS.compressedSize] ?? response.ContentLength ?? 0),
        storageKey: key,
      }
      if (md[META_FIELDS.contentType]) meta.contentType = md[META_FIELDS.contentType]
      return meta
    } catch (err: unknown) {
      const name = (err as { name?: string }).name
      if (name === 'NotFound' || name === 'NoSuchKey') return null
      throw err
    }
  }

  async putIfAbsent(key: string, bytes: AsyncIterable<Uint8Array>, meta: PutMeta): Promise<PutResult> {
    const existing = await this.head(key)
    if (existing) {
      assertNoConflict(existing, meta)
      return { meta: existing, alreadyExisted: true }
    }
    const buffer = await asyncIterableToUint8Array(bytes)
    verifyBytes(buffer, meta)
    const metadata: Record<string, string> = {
      [META_FIELDS.hash]: meta.hash,
      [META_FIELDS.hashAlgorithm]: meta.hashAlgorithm,
      [META_FIELDS.uncompressedSize]: String(meta.uncompressedSize),
      [META_FIELDS.compressedSize]: String(meta.compressedSize),
    }
    if (meta.contentType) metadata[META_FIELDS.contentType] = meta.contentType
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        Metadata: metadata,
        ContentType: meta.contentType ?? 'application/octet-stream',
        // Conditional write for S3-compatible endpoints that support it.
        IfNoneMatch: '*',
      }),
    )
    return { meta: { ...meta, storageKey: key }, alreadyExisted: false }
  }

  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    const body = response.Body as
      | ReadableStream<Uint8Array>
      | (AsyncIterable<Uint8Array> & { transformToWebStream?: () => ReadableStream<Uint8Array> })
      | undefined
    if (!body) throw new Error(`S3ObjectStore.get: empty response body for ${key}`)
    if (body instanceof ReadableStream) return body
    if (typeof body.transformToWebStream === 'function') return body.transformToWebStream()
    const reader = body[Symbol.asyncIterator]()
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await reader.next()
        if (next.done) controller.close()
        else controller.enqueue(next.value)
      },
    })
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }
}
