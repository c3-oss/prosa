// Lane 6 — `POST /v2/reads/artifacts/getText` handler.
//
// Multi-step gate before any bytes leave the server:
//
//   1. Verified-projection gate on `projection_artifact`. The
//      artifact row must belong to a `(tenant, store)` whose
//      current authority's receipt id matches the row's
//      `receipt_id`.
//   2. Receipt-pack-grant check. The receipt that owns the
//      projection row must have an entry in `receipt_pack_grant`
//      for the pack that holds the underlying object. Authority
//      alone is not enough; the receipt must explicitly own the
//      pack.
//   3. Pack catalog lookup. `remote_pack_entry` resolves the
//      stored byte range / hash / compression; `remote_pack` gives
//      the storage URI.
//   4. Bounded byte fetch. The object store reads at most
//      `entry.stored_length` bytes; zstd-compressed entries
//      decompress through `decompressZstdBounded` so the
//      decompressed payload is capped at `maxBytes`. Raw entries
//      go through `readRawBounded`.
//   5. UTF-8 sniff. Text-looking payloads are returned as
//      `kind: 'text'`; binary payloads return `kind: 'binary'`
//      with an empty `text` field.
//
// CQ-144: every miss path — missing artifact, superseded receipt,
// missing pack grant, missing remote_pack_entry, missing object
// bytes, or fetch/decompress failure — collapses to a single
// opaque `{ found: false }` response. The handler logs internal
// reasons through the optional `onMiss` hook for operators but
// never surfaces them to the caller.

import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import { z } from 'zod'
import type { RawExec } from '../../../db.js'
import { decompressZstdBounded, readRawBounded } from '../../../trpc/routers/reads/bounded-decode.js'
import { verifiedProjectionWhere } from '../shared/verified-projection.js'

export const ARTIFACT_TEXT_MAX_BYTES_DEFAULT = 256 * 1024
export const ARTIFACT_TEXT_MAX_BYTES_LIMIT = 2 * 1024 * 1024

export const artifactGetTextInput = z.object({
  artifactId: z.string().min(1),
  maxBytes: z.number().int().min(1024).max(ARTIFACT_TEXT_MAX_BYTES_LIMIT).default(ARTIFACT_TEXT_MAX_BYTES_DEFAULT),
})

export type ArtifactGetTextInput = z.infer<typeof artifactGetTextInput>

/**
 * Server-internal miss reason. Never returned to callers; emitted
 * through `ArtifactsDeps.onMiss` so operators can correlate logs.
 */
export type ArtifactMissReason = 'not_visible' | 'no_grant' | 'no_object' | 'fetch_failed'

export type ArtifactGetTextResponse =
  | {
      found: true
      artifactId: string
      objectId: string
      contentType: string | null
      bytesReturned: number
      uncompressedSize: number | null
      truncated: boolean
      text: string
      kind: 'text' | 'binary'
      storeId: string
      receiptId: string
    }
  | { found: false }

type ResolvedArtifact = {
  artifactId: string
  objectId: string
  contentType: string | null
  byteLength: number | null
  storeId: string
  receiptId: string
  storageUri: string
  storedOffset: number
  storedLength: number
  compression: 'zstd' | 'none'
  uncompressedSize: number | null
}

export type ArtifactsDeps = {
  rawExec: RawExec
  objectStore: RemoteObjectStore
  /**
   * Optional server-side observability hook fired with the internal
   * miss reason. Never reaches the response — `getArtifactText`
   * collapses every miss to `{ found: false }` per CQ-144.
   */
  onMiss?: (tenantId: string, artifactId: string, reason: ArtifactMissReason) => void
}

type Row = {
  artifact_id: string
  object_id: string | null
  content_type: string | null
  byte_length: number | null
  store_id: string
  receipt_id: string
  pack_digest: string
  storage_uri: string
  stored_offset: number
  stored_length: number
  compression: 'zstd' | 'none'
  uncompressed_size: number | null
}

export async function getArtifactText(
  deps: ArtifactsDeps,
  tenantId: string,
  input: ArtifactGetTextInput,
): Promise<ArtifactGetTextResponse> {
  // Single round-trip: verified-projection gate on the artifact +
  // grant + pack-entry chain. A missing JOIN row collapses to
  // `not_visible` / `no_grant` / `no_object` depending on which
  // edge failed; the SQL returns 0 rows when *anything* in the
  // chain is missing so we re-derive the reason with a cheap
  // follow-up. The caller-visible response stays opaque (CQ-144) —
  // an unexpected SQL failure (e.g. v2 projection schema not yet
  // applied to a tenant's data path) also collapses to `not_visible`
  // so the route never leaks server state via an unhandled 500.
  let rows: Row[]
  try {
    rows = await deps.rawExec<Row>(
      `SELECT a.artifact_id, a.object_id, a.content_type, a.byte_length,
              a.store_id, a.receipt_id,
              pe.pack_digest, p.storage_uri, pe.stored_offset, pe.stored_length,
              pe.compression, pe.uncompressed_size
         FROM projection_artifact a
         JOIN remote_pack_entry pe
           ON pe.tenant_id = a.tenant_id
          AND pe.object_id = a.object_id
         JOIN remote_pack p
           ON p.tenant_id = pe.tenant_id
          AND p.pack_digest = pe.pack_digest
         JOIN receipt_pack_grant g
           ON g.tenant_id = a.tenant_id
          AND g.receipt_id = a.receipt_id
          AND g.pack_digest = pe.pack_digest
        WHERE ${verifiedProjectionWhere('a')}
          AND a.artifact_id = $2
        LIMIT 1`,
      [tenantId, input.artifactId],
    )
  } catch {
    return missOpaque(deps, tenantId, input.artifactId, 'not_visible')
  }

  if (rows.length === 0) {
    return missOpaque(deps, tenantId, input.artifactId, await diagnoseMissReason(deps, tenantId, input.artifactId))
  }
  const row = rows[0]!
  if (!row.object_id) {
    return missOpaque(deps, tenantId, input.artifactId, 'no_object')
  }
  const resolved: ResolvedArtifact = {
    artifactId: row.artifact_id,
    objectId: row.object_id,
    contentType: row.content_type,
    byteLength: row.byte_length,
    storeId: row.store_id,
    receiptId: row.receipt_id,
    storageUri: row.storage_uri,
    storedOffset: Number(row.stored_offset),
    storedLength: Number(row.stored_length),
    compression: row.compression,
    uncompressedSize: row.uncompressed_size != null ? Number(row.uncompressed_size) : null,
  }

  let stream: ReadableStream<Uint8Array>
  try {
    stream = await deps.objectStore.getRange(resolved.storageUri, resolved.storedOffset, resolved.storedLength)
  } catch {
    return missOpaque(deps, tenantId, input.artifactId, 'fetch_failed')
  }

  const iter: AsyncIterable<Uint8Array> = streamToAsyncIterable(stream)
  let decoded: Awaited<ReturnType<typeof decompressZstdBounded>>
  try {
    decoded =
      resolved.compression === 'zstd'
        ? await decompressZstdBounded(iter, input.maxBytes)
        : await readRawBounded(iter, input.maxBytes)
  } catch {
    return missOpaque(deps, tenantId, input.artifactId, 'fetch_failed')
  }

  const textLike = looksLikeText(resolved.contentType, decoded.decoded)
  return {
    found: true,
    artifactId: resolved.artifactId,
    objectId: resolved.objectId,
    contentType: resolved.contentType,
    bytesReturned: decoded.decoded.byteLength,
    uncompressedSize: resolved.uncompressedSize,
    truncated: decoded.truncated,
    text: textLike ? decoded.decoded.toString('utf8') : '',
    kind: textLike ? 'text' : 'binary',
    storeId: resolved.storeId,
    receiptId: resolved.receiptId,
  }
}

function missOpaque(
  deps: ArtifactsDeps,
  tenantId: string,
  artifactId: string,
  reason: ArtifactMissReason,
): ArtifactGetTextResponse {
  deps.onMiss?.(tenantId, artifactId, reason)
  return { found: false }
}

async function diagnoseMissReason(
  deps: ArtifactsDeps,
  tenantId: string,
  artifactId: string,
): Promise<ArtifactMissReason> {
  // Diagnostic only. The response stays opaque; only `onMiss` sees
  // the reason. Distinguishes "row is invisible under current
  // authority" from "row is visible but lacks an object id / pack
  // grant" so an operator can tell the two apart. An unexpected
  // SQL failure (missing v2 projection table) collapses to
  // `not_visible` — the same opaque shape, just with a different
  // server-side hint.
  try {
    const rows = await deps.rawExec<{ object_id: string | null; receipt_id: string }>(
      `SELECT a.object_id, a.receipt_id
         FROM projection_artifact a
        WHERE ${verifiedProjectionWhere('a')} AND a.artifact_id = $2
        LIMIT 1`,
      [tenantId, artifactId],
    )
    const row = rows[0]
    if (!row) return 'not_visible'
    if (!row.object_id) return 'no_object'
    return 'no_grant'
  } catch {
    return 'not_visible'
  }
}

function looksLikeText(contentType: string | null, decoded: Uint8Array): boolean {
  if (contentType?.startsWith('text/')) return true
  if (contentType?.includes('json') || contentType?.includes('xml')) return true
  const sample = decoded.subarray(0, Math.min(decoded.byteLength, 4096))
  let printable = 0
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)) printable += 1
  }
  return sample.byteLength === 0 || printable / sample.byteLength >= 0.9
}

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
