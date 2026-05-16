import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
  S3Client as S3ClientCtor,
} from '@aws-sdk/client-s3'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import {
  type ObjectMeta,
  PUT_PREVERIFIED_BYTES,
  type PutMeta,
  type PutResult,
  type RemoteObjectStore,
  asyncIterableToUint8Array,
  uint8ArrayToWebStream,
} from '../types.js'
import { ObjectVerificationError, assertNoConflict, verifyBytes } from '../verify.js'

const sharedHttpAgent = new HttpAgent({ keepAlive: true, maxSockets: 50 })
const sharedHttpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 50 })
const sharedRequestHandler = new NodeHttpHandler({
  httpAgent: sharedHttpAgent,
  httpsAgent: sharedHttpsAgent,
})

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
        requestHandler: sharedRequestHandler,
        ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
        ...((opts.forcePathStyle ?? opts.endpoint) ? { forcePathStyle: true } : {}),
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
    return this.put(key, bytes, meta, { verify: true })
  }

  async [PUT_PREVERIFIED_BYTES](key: string, bytes: AsyncIterable<Uint8Array>, meta: PutMeta): Promise<PutResult> {
    return this.put(key, bytes, meta, { verify: false })
  }

  private async put(
    key: string,
    bytes: AsyncIterable<Uint8Array>,
    meta: PutMeta,
    opts: { verify: boolean },
  ): Promise<PutResult> {
    const existing = await this.head(key)
    if (existing) {
      assertNoConflict(existing, meta)
      return { meta: existing, alreadyExisted: true }
    }
    const buffer = await asyncIterableToUint8Array(bytes)
    if (opts.verify) verifyBytes(buffer, meta)
    const metadata: Record<string, string> = {
      [META_FIELDS.hash]: meta.hash,
      [META_FIELDS.hashAlgorithm]: meta.hashAlgorithm,
      [META_FIELDS.uncompressedSize]: String(meta.uncompressedSize),
      [META_FIELDS.compressedSize]: String(meta.compressedSize),
    }
    if (meta.contentType) metadata[META_FIELDS.contentType] = meta.contentType
    try {
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
    } catch (err) {
      if (!isPreconditionFailed(err)) throw err
      const raced = await this.head(key)
      if (!raced) {
        throw new ObjectVerificationError('conditional put failed but existing object metadata is missing')
      }
      assertNoConflict(raced, meta)
      return { meta: raced, alreadyExisted: true }
    }
    return { meta: { ...meta, storageKey: key }, alreadyExisted: false }
  }

  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    return bodyToWebStream(response.Body, `S3ObjectStore.get: empty response body for ${key}`)
  }

  async getRange(key: string, offset: number, length: number): Promise<ReadableStream<Uint8Array>> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
      throw new Error(`S3ObjectStore.getRange: invalid range for ${key}`)
    }
    if (length === 0) return uint8ArrayToWebStream(new Uint8Array())
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: `bytes=${offset}-${offset + length - 1}`,
      }),
    )
    return bodyToWebStream(response.Body, `S3ObjectStore.getRange: empty response body for ${key}`)
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }
}

function bodyToWebStream(body: unknown, emptyMessage: string): ReadableStream<Uint8Array> {
  const typedBody = body as
    | ReadableStream<Uint8Array>
    | (AsyncIterable<Uint8Array> & { transformToWebStream?: () => ReadableStream<Uint8Array> })
    | undefined
  if (!typedBody) throw new Error(emptyMessage)
  if (typedBody instanceof ReadableStream) return typedBody
  if (typeof typedBody.transformToWebStream === 'function') return typedBody.transformToWebStream()
  const reader = typedBody[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.next()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
  })
}

function isPreconditionFailed(err: unknown): boolean {
  const value = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } }
  return (
    value.name === 'PreconditionFailed' ||
    value.Code === 'PreconditionFailed' ||
    value.$metadata?.httpStatusCode === 412
  )
}
