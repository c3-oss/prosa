import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { DecompressStream } from 'zstd-napi'
import { router, tenantProcedure } from '../../init.js'

const artifactInput = z
  .object({
    artifactId: z.string().optional(),
    objectId: z.string().optional(),
    maxBytes: z.number().int().min(1024).max(2_000_000).default(256_000),
  })
  .refine((v) => v.artifactId || v.objectId, {
    message: 'artifactId or objectId is required',
  })

type ResolveResult = {
  objectId: string
  storageKey: string
  compression: string
  contentType: string | null
  artifactId: string | null
  /**
   * True when the resolution path proved verified object provenance (a
   * `verified` sync_batch_object_manifest entry exists for this object).
   * Lane 08 CQ-003 requires verified object provenance, not just tenant
   * ownership, before bytes are returned.
   */
  objectVerified: boolean
}

async function resolveArtifact(
  ctx: Parameters<Parameters<typeof tenantProcedure.query>[0]>[0]['ctx'],
  input: z.infer<typeof artifactInput>,
): Promise<ResolveResult | null> {
  if (input.artifactId) {
    // CQ-003: require both verified projection ownership AND verified object
    // provenance. The artifact row must belong to a verified-promoted session
    // for this tenant AND the referenced object must be granted to this
    // tenant AND that object must be declared by a verified batch's object
    // manifest.
    const rows = await ctx.rawExec<{
      id: string
      object_id: string | null
      storage_key: string | null
      compression: string | null
      content_type: string | null
    }>(
      `SELECT a.id,
              a.object_id,
              o.storage_key,
              o.compression,
              o.content_type
         FROM "projection_artifact" a
         JOIN "tenant_object" tx
           ON tx.tenant_id = a.tenant_id AND tx.object_id = a.object_id
    LEFT JOIN "remote_object" o ON o.object_id = a.object_id
        WHERE a.tenant_id = $1 AND a.id = $2
          AND EXISTS (
            SELECT 1 FROM "sync_batch_projection_manifest" m
            JOIN "sync_batch" b ON b.id = m.batch_id AND b.status = 'verified'
            WHERE m.tenant_id = a.tenant_id AND m.entity_type = 'session' AND m.entity_id = a.session_id
          )
          AND EXISTS (
            SELECT 1 FROM "sync_batch_object_manifest" om
            JOIN "sync_batch" b2 ON b2.id = om.batch_id AND b2.status = 'verified'
            WHERE om.tenant_id = a.tenant_id AND om.object_id = a.object_id
          )
        LIMIT 1`,
      [ctx.tenantId, input.artifactId],
    )
    const row = rows[0]
    if (!row || !row.object_id || !row.storage_key) return null
    return {
      objectId: row.object_id,
      storageKey: row.storage_key,
      compression: row.compression ?? 'zstd',
      contentType: row.content_type,
      artifactId: row.id,
      objectVerified: true,
    }
  }
  if (input.objectId) {
    // CQ-003: for raw object refs the object must (1) be granted to this
    // tenant via tenant_object AND (2) have been declared+verified by a
    // promoted batch's object manifest. Committed-but-unverified objects
    // are never readable.
    const rows = await ctx.rawExec<{
      object_id: string
      storage_key: string
      compression: string
      content_type: string | null
    }>(
      `SELECT o.object_id, o.storage_key, o.compression, o.content_type
         FROM "tenant_object" tx
         JOIN "remote_object" o ON o.object_id = tx.object_id
        WHERE tx.tenant_id = $1 AND tx.object_id = $2
          AND EXISTS (
            SELECT 1 FROM "sync_batch_object_manifest" om
            JOIN "sync_batch" b ON b.id = om.batch_id AND b.status = 'verified'
            WHERE om.tenant_id = tx.tenant_id AND om.object_id = tx.object_id
          )
        LIMIT 1`,
      [ctx.tenantId, input.objectId],
    )
    const row = rows[0]
    if (!row) return null
    return {
      objectId: row.object_id,
      storageKey: row.storage_key,
      compression: row.compression,
      contentType: row.content_type,
      artifactId: null,
      objectVerified: true,
    }
  }
  return null
}

class DecodeCap {
  private capPlusOne: number
  private collected = 0
  private chunks: Buffer[] = []
  constructor(maxBytes: number) {
    this.capPlusOne = maxBytes + 1
  }

  /** Append a chunk and return true if the cap was exceeded. */
  push(chunk: Buffer): boolean {
    if (this.collected >= this.capPlusOne) return true
    const need = this.capPlusOne - this.collected
    const slice = chunk.byteLength > need ? chunk.subarray(0, need) : chunk
    this.chunks.push(slice)
    this.collected += slice.byteLength
    return this.collected >= this.capPlusOne
  }

  /** Returns the bytes collected so far, up to capPlusOne. */
  finish(): Buffer {
    return Buffer.concat(this.chunks, this.collected)
  }

  exceededCap(maxBytes: number): boolean {
    return this.collected > maxBytes
  }
}

/**
 * CQ-009: decompress only as many bytes as the preview cap requires. Once
 * `maxBytes + 1` decoded bytes have been collected we stop pulling from the
 * underlying stream and tear it down.
 */
async function decompressZstdBounded(
  raw: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<{ decoded: Buffer; truncated: boolean }> {
  const decompressor = new DecompressStream()
  const cap = new DecodeCap(maxBytes)
  const sink = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const stop = cap.push(buf)
      if (stop) {
        // Signal end-of-pipeline via an error the caller silences below.
        cb(new BoundedDecodeStop())
        return
      }
      cb()
    },
  })
  try {
    await pipeline(Readable.from(raw), decompressor, sink)
  } catch (err) {
    if (!(err instanceof BoundedDecodeStop)) throw err
  }
  const exceeded = cap.exceededCap(maxBytes)
  const collected = cap.finish()
  const trimmed = exceeded ? collected.subarray(0, maxBytes) : collected
  return { decoded: trimmed, truncated: exceeded }
}

class BoundedDecodeStop extends Error {
  override readonly name = 'BoundedDecodeStop'
}

/** Read raw bytes (no compression) up to maxBytes+1 from the stream. */
async function readRawBounded(
  raw: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<{ decoded: Buffer; truncated: boolean }> {
  const cap = new DecodeCap(maxBytes)
  for await (const chunk of raw) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (cap.push(buf)) break
  }
  const exceeded = cap.exceededCap(maxBytes)
  const collected = cap.finish()
  const trimmed = exceeded ? collected.subarray(0, maxBytes) : collected
  return { decoded: trimmed, truncated: exceeded }
}

function looksLikeText(contentType: string | null, decoded: Uint8Array): boolean {
  if (contentType?.startsWith('text/')) return true
  if (contentType?.includes('json') || contentType?.includes('xml')) return true
  // Heuristic: most bytes are printable / whitespace.
  const sample = decoded.subarray(0, Math.min(decoded.byteLength, 4096))
  let printable = 0
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)) printable += 1
  }
  return sample.byteLength === 0 || printable / sample.byteLength >= 0.9
}

export const artifactsRouter = router({
  getText: tenantProcedure.input(artifactInput).query(async ({ ctx, input }) => {
    const resolved = await resolveArtifact(ctx, input)
    if (!resolved) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Artifact or object is not accessible to this tenant.',
      })
    }
    const stream = await ctx.objectStore.get(resolved.storageKey)
    const asyncIter: AsyncIterable<Uint8Array> =
      Symbol.asyncIterator in stream ? (stream as unknown as AsyncIterable<Uint8Array>) : streamToAsyncIterable(stream)
    const { decoded, truncated } =
      resolved.compression === 'zstd'
        ? await decompressZstdBounded(asyncIter, input.maxBytes)
        : await readRawBounded(asyncIter, input.maxBytes)
    const textLike = looksLikeText(resolved.contentType, decoded)
    return {
      id: resolved.artifactId ?? resolved.objectId,
      objectId: resolved.objectId,
      contentType: resolved.contentType,
      bytesReturned: decoded.byteLength,
      truncated,
      text: textLike ? decoded.toString('utf8') : '',
      kind: textLike ? ('text' as const) : ('binary' as const),
    }
  }),
})

async function* streamToAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      if (value) yield value
    }
  } finally {
    reader.releaseLock()
  }
}
