import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  type ObjectByteLocation,
  readObjectByteLocation,
  resolveObjectByteLocation,
} from '../../../objects/locations.js'
import { router, tenantProcedure } from '../../init.js'
import { decompressZstdBounded, readRawBounded } from './bounded-decode.js'
import { verifiedProjectionExistsSql } from './shared.js'

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
  location: ObjectByteLocation
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
      compression: string | null
      content_type: string | null
    }>(
      `SELECT a.id,
              a.object_id,
              o.compression,
              o.content_type
         FROM "projection_artifact" a
         JOIN "tenant_object" tx
           ON tx.tenant_id = a.tenant_id AND tx.object_id = a.object_id
    LEFT JOIN "remote_object" o ON o.object_id = a.object_id
        WHERE a.tenant_id = $1 AND a.id = $2
          AND ${verifiedProjectionExistsSql('a', 'artifact')}
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
    if (!row || !row.object_id) return null
    const location = await resolveObjectByteLocation(ctx.rawExec, row.object_id, ctx.tenantId)
    if (!location) return null
    return {
      objectId: row.object_id,
      location,
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
      compression: string
      content_type: string | null
    }>(
      `SELECT o.object_id, o.compression, o.content_type
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
    const location = await resolveObjectByteLocation(ctx.rawExec, row.object_id, ctx.tenantId)
    if (!location) return null
    return {
      objectId: row.object_id,
      location,
      compression: row.compression,
      contentType: row.content_type,
      artifactId: null,
      objectVerified: true,
    }
  }
  return null
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
    const stream = await readObjectByteLocation(ctx.objectStore, resolved.location)
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
