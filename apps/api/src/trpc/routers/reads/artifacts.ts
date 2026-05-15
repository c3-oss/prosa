import { Readable } from 'node:stream'
import { buffer as bufferStream } from 'node:stream/consumers'
import { asyncIterableToUint8Array } from '@c3-oss/prosa-storage'
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
}

async function resolveArtifact(
  ctx: Parameters<Parameters<typeof tenantProcedure.query>[0]>[0]['ctx'],
  input: z.infer<typeof artifactInput>,
): Promise<ResolveResult | null> {
  if (input.artifactId) {
    // Tenant ownership is enforced by the projection row + verified manifest.
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
    LEFT JOIN "remote_object" o ON o.object_id = a.object_id
        WHERE a.tenant_id = $1 AND a.id = $2
          AND EXISTS (
            SELECT 1 FROM "sync_batch_projection_manifest" m
            JOIN "sync_batch" b ON b.id = m.batch_id AND b.status = 'verified'
            WHERE m.tenant_id = a.tenant_id AND m.entity_type = 'session' AND m.entity_id = a.session_id
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
    }
  }
  if (input.objectId) {
    // For raw object refs we still require the object to be referenced by
    // verified projection data for this tenant — via tenant_object ref count.
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
    }
  }
  return null
}

async function decompressZstd(input: Uint8Array): Promise<Uint8Array> {
  const decompressed = await bufferStream(Readable.from([Buffer.from(input)]).pipe(new DecompressStream()))
  return new Uint8Array(decompressed)
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
    const rawBytes = await asyncIterableToUint8Array(asyncIter)
    const decoded = resolved.compression === 'zstd' ? await decompressZstd(rawBytes) : rawBytes
    const truncated = decoded.byteLength > input.maxBytes
    const trimmed = truncated ? decoded.subarray(0, input.maxBytes) : decoded
    const textLike = looksLikeText(resolved.contentType, trimmed)
    return {
      id: resolved.artifactId ?? resolved.objectId,
      objectId: resolved.objectId,
      contentType: resolved.contentType,
      bytesReturned: trimmed.byteLength,
      truncated,
      text: textLike ? Buffer.from(trimmed).toString('utf8') : '',
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
