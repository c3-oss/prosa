// Lane 5 — UploadSegment handler.
//
// `PUT /v2/promotions/:promotionId/segments/:segmentId` receives the raw
// bytes of an inventory segment (object or projection) for an open
// staging slot. The handler:
//
// 1. Looks up the `promotion_staging` row by `(id, tenant_id)` — a
//    miss is `404 PROMOTION_NOT_FOUND`. The tenant filter prevents
//    cross-tenant promotion targeting (I1).
// 2. Finds the declared segment ref (from `inventory_object_ref` /
//    `inventory_projection_ref`) by `segmentId`. No match → `404
//    SEGMENT_NOT_DECLARED`.
// 3. Reads the octet-stream body, verifies:
//    - body length matches the declared `byteLength`,
//    - BLAKE3 of the body equals the declared `digest` (CQ-012
//      canonical content identity),
//    - optional `x-prosa-transport-hash` header matches the same
//      streamed BLAKE3 (transport-vs-canonical is the same value for
//      inventory segments since they ship as raw bytes; this
//      assertion catches mismatched-header clients).
// 4. `putIfAbsent` into the object store at
//    `staging/<tenant>/<promotionId>/<segmentId>` — re-upload of the
//    same bytes is idempotent (`already_present`).
// 5. Touches `promotion_staging.updated_at` so audit visibility moves.

import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import type { SegmentRefWire } from '@c3-oss/prosa-wire-v2'
import { blake3 } from '@noble/hashes/blake3'
import type { RawExec } from '../../db.js'

export type UploadSegmentDeps = {
  rawExec: RawExec
  tenantId: string
  objectStore: RemoteObjectStore
}

export type UploadSegmentParams = {
  promotionId: string
  segmentId: string
  /** Streaming body bytes (Buffer/Uint8Array). */
  body: Uint8Array
  /** Optional `x-prosa-transport-hash: blake3:<hex>` header. */
  transportHash?: string
}

export type UploadSegmentResult =
  | { status: 'accepted'; segmentId: string; storageKey: string }
  | { status: 'already_present'; segmentId: string; storageKey: string }

export class UploadSegmentNotFoundError extends Error {
  override name = 'UploadSegmentNotFoundError'
  constructor(
    message: string,
    readonly code: 'PROMOTION_NOT_FOUND' | 'SEGMENT_NOT_DECLARED',
  ) {
    super(message)
  }
}

export class UploadSegmentValidationError extends Error {
  override name = 'UploadSegmentValidationError'
  constructor(
    message: string,
    readonly issues: Array<{ field: string; expected: string; received: string }>,
  ) {
    super(message)
  }
}

type StagingRow = {
  status: string
  inventory_object_ref: unknown
  inventory_projection_ref: unknown
}

// CQ-131: once seal moves the slot to `materializing`, the upload
// routes must refuse new bytes — the catalog/authority swap is
// running and any late upload would have nowhere to bind. Sealed
// and aborted slots are likewise terminal.
const CLOSED_STAGING_STATUSES = new Set(['sealed', 'aborted', 'materializing'])

export async function uploadSegment(
  deps: UploadSegmentDeps,
  params: UploadSegmentParams,
): Promise<UploadSegmentResult> {
  const rows = await deps.rawExec<StagingRow>(
    `SELECT status, inventory_object_ref, inventory_projection_ref
       FROM promotion_staging
      WHERE id = $1 AND tenant_id = $2
      LIMIT 1`,
    [params.promotionId, deps.tenantId],
  )
  if (rows.length === 0) {
    throw new UploadSegmentNotFoundError(`promotion ${params.promotionId} not found`, 'PROMOTION_NOT_FOUND')
  }
  const row = rows[0]!
  if (CLOSED_STAGING_STATUSES.has(row.status)) {
    throw new UploadSegmentNotFoundError(
      `promotion ${params.promotionId} is ${row.status}; cannot accept new segments`,
      'PROMOTION_NOT_FOUND',
    )
  }

  const candidates: Array<SegmentRefWire | null> = [
    parseSegmentRef(row.inventory_object_ref),
    parseSegmentRef(row.inventory_projection_ref),
  ]
  const segment = candidates.find((s): s is SegmentRefWire => s != null && s.segmentId === params.segmentId)
  if (!segment) {
    throw new UploadSegmentNotFoundError(
      `segment ${params.segmentId} is not declared on promotion ${params.promotionId}`,
      'SEGMENT_NOT_DECLARED',
    )
  }

  const issues: Array<{ field: string; expected: string; received: string }> = []

  if (params.body.byteLength !== segment.byteLength) {
    issues.push({
      field: 'byteLength',
      expected: String(segment.byteLength),
      received: String(params.body.byteLength),
    })
  }

  const observedHash = `blake3:${toHex(blake3(params.body))}`
  if (observedHash !== segment.digest) {
    issues.push({ field: 'digest', expected: segment.digest, received: observedHash })
  }
  // CQ-130: the wire schema (`uploadSegmentRequestSchema`) requires
  // `transportHash` so the server can independently catch in-flight
  // chunk re-framing corruption. The handler enforces presence here
  // even though digest verification would catch many of the same
  // corruptions — the spec separates transport from canonical hash
  // on purpose (CQ-012).
  if (params.transportHash === undefined) {
    issues.push({ field: 'transportHash', expected: 'blake3:<64-hex>', received: '<missing>' })
  } else if (params.transportHash !== observedHash) {
    issues.push({ field: 'transportHash', expected: observedHash, received: params.transportHash })
  }

  if (issues.length > 0) {
    throw new UploadSegmentValidationError('uploaded bytes do not match declared segment', issues)
  }

  const storageKey = stagingObjectKey(deps.tenantId, params.promotionId, params.segmentId)
  const putResult = await deps.objectStore.putIfAbsent(storageKey, asyncOnce(params.body), {
    hash: observedHash.slice('blake3:'.length),
    hashAlgorithm: 'blake3',
    uncompressedSize: segment.byteLength,
    compressedSize: segment.byteLength,
  })

  // Touch updated_at so audit / GC visibility moves even when the put
  // is a no-op (re-upload). Status transitions are reserved for the
  // seal slice.
  await deps.rawExec(`UPDATE promotion_staging SET updated_at = now() WHERE id = $1 AND tenant_id = $2`, [
    params.promotionId,
    deps.tenantId,
  ])

  return {
    status: putResult.alreadyExisted ? 'already_present' : 'accepted',
    segmentId: params.segmentId,
    storageKey,
  }
}

export function stagingObjectKey(tenantId: string, promotionId: string, segmentId: string): string {
  return `staging/${tenantId}/${promotionId}/${segmentId}`
}

function parseSegmentRef(value: unknown): SegmentRefWire | null {
  if (value == null) return null
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as SegmentRefWire
    } catch {
      return null
    }
  }
  if (typeof value === 'object') return value as SegmentRefWire
  return null
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0')
  }
  return out
}

async function* asyncOnce(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes
}
