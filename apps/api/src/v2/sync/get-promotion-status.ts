// Lane 5 — GetPromotionStatus handler.
//
// `GET /v2/promotions/:promotionId/status` lets a client recovering
// from an interrupted promotion ask the server which inventory
// segments and object packs are already uploaded. The client uses
// the answer to skip re-transmitting bytes the server already has.
//
// Like every other Lane 5 route the lookup is tenant-scoped: a miss
// (including a cross-tenant promotionId) is a tenant-isolated 404.

import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import type { SegmentRefWire } from '@c3-oss/prosa-wire-v2'
import type { RawExec } from '../../db.js'
import { stagingObjectKey } from './upload-segment.js'

export type GetPromotionStatusDeps = {
  rawExec: RawExec
  tenantId: string
  objectStore: RemoteObjectStore
}

export type GetPromotionStatusParams = {
  promotionId: string
  /** CQ-127: requesting device id. When set, must match staging.device_id. */
  requestingDeviceId?: string
}

export type GetPromotionStatusResult = {
  status: 'open' | 'uploading' | 'materializing' | 'sealed' | 'aborted'
  promotionId: string
  bundleRoot: string | null
  storeId: string
  inventories: {
    object: { segmentId: string | null; uploaded: boolean }
    projection: { segmentId: string | null; uploaded: boolean }
  }
  uploadedPackDigests: string[]
}

export class GetPromotionStatusNotFoundError extends Error {
  override name = 'GetPromotionStatusNotFoundError'
  readonly code = 'PROMOTION_NOT_FOUND' as const
}

export class GetPromotionStatusDeviceMismatchError extends Error {
  override name = 'GetPromotionStatusDeviceMismatchError'
  readonly code = 'DEVICE_MISMATCH' as const
  constructor(
    readonly stagingDeviceId: string,
    readonly requestingDeviceId: string,
  ) {
    super(
      `promotion is owned by device ${stagingDeviceId}; ` + `requesting device ${requestingDeviceId} cannot read it`,
    )
  }
}

type StagingRow = {
  status: GetPromotionStatusResult['status']
  store_id: string
  device_id: string
  head_json: unknown
  inventory_object_ref: unknown
  inventory_projection_ref: unknown
}

export async function getPromotionStatus(
  deps: GetPromotionStatusDeps,
  params: GetPromotionStatusParams,
): Promise<GetPromotionStatusResult> {
  const rows = await deps.rawExec<StagingRow>(
    `SELECT status, store_id, device_id, head_json, inventory_object_ref, inventory_projection_ref
       FROM promotion_staging
      WHERE id = $1 AND tenant_id = $2
      LIMIT 1`,
    [params.promotionId, deps.tenantId],
  )
  if (rows.length === 0) {
    throw new GetPromotionStatusNotFoundError(`promotion ${params.promotionId} not found`)
  }
  const row = rows[0]!
  if (params.requestingDeviceId !== undefined && params.requestingDeviceId !== row.device_id) {
    throw new GetPromotionStatusDeviceMismatchError(row.device_id, params.requestingDeviceId)
  }

  const objectInventory = parseSegmentRef(row.inventory_object_ref)
  const projectionInventory = parseSegmentRef(row.inventory_projection_ref)

  const [objectUploaded, projectionUploaded] = await Promise.all([
    objectInventory ? hasStagingObject(deps, params.promotionId, objectInventory.segmentId) : Promise.resolve(false),
    projectionInventory
      ? hasStagingObject(deps, params.promotionId, projectionInventory.segmentId)
      : Promise.resolve(false),
  ])

  const packRows = await deps.rawExec<{ pack_digest: string }>(
    `SELECT pack_digest FROM promotion_uploaded_pack
      WHERE promotion_id = $1 AND tenant_id = $2
      ORDER BY uploaded_at ASC`,
    [params.promotionId, deps.tenantId],
  )

  const head = coerceJsonbObject(row.head_json)
  const bundleRoot =
    head && typeof (head as { bundleRoot?: unknown }).bundleRoot === 'string'
      ? (head as { bundleRoot: string }).bundleRoot
      : null

  return {
    status: row.status,
    promotionId: params.promotionId,
    bundleRoot,
    storeId: row.store_id,
    inventories: {
      object: { segmentId: objectInventory?.segmentId ?? null, uploaded: objectUploaded },
      projection: { segmentId: projectionInventory?.segmentId ?? null, uploaded: projectionUploaded },
    },
    uploadedPackDigests: packRows.map((r) => r.pack_digest),
  }
}

async function hasStagingObject(
  deps: GetPromotionStatusDeps,
  promotionId: string,
  segmentId: string,
): Promise<boolean> {
  const meta = await deps.objectStore.head(stagingObjectKey(deps.tenantId, promotionId, segmentId))
  return meta !== null
}

function parseSegmentRef(value: unknown): SegmentRefWire | null {
  const obj = coerceJsonbObject(value)
  if (!obj) return null
  if (typeof (obj as { segmentId?: unknown }).segmentId !== 'string') return null
  return obj as SegmentRefWire
}

function coerceJsonbObject(value: unknown): Record<string, unknown> | null {
  if (value == null) return null
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}
