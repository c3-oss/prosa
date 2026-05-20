// Lane 5 — BeginPromotion handler.
//
// Implements the no-op fast path against an already-promoted bundle:
// when `(tenant_id, store_id, current_bundle_root)` exists in
// `remote_authority_v2`, fetch the matching receipt row and return
// `{ status: 'already_promoted', receipt }`.
//
// Staging / `needs_inventory` / `needs_upload` paths are deferred to
// later Lane 5 slices. Until they land, fresh bundles return a
// `needs_inventory` placeholder so the wire response still validates but
// the client cannot drive uploads — the next slice will replace this
// with real staging/missing-segment computation.
//
// Validation note: the public `prosa-wire-v2` `beginPromotionRequestSchema`
// constrains `tenantId` to `canonicalIdSchema` (lowercase). Production
// tenant_id values come from Better Auth's `organization.id`, which is a
// mixed-case nanoid and never matches canonical lowercase. The server
// therefore validates the body shape with a server-local schema that
// treats `tenantId`, `storeId`, and `deviceId` as opaque strings, and
// uses `ctx.tenantId` (Better Auth-resolved) as the authoritative tenant
// for all queries. The bundle/segment/hash fields keep their canonical
// schemas because they are content-addressed and producer-controlled.
//
// Invariants enforced here:
// - I1 tenant isolation: every query filters by `ctx.tenantId`. The body
//   `tenantId` is a client-side sanity check and is compared to
//   `ctx.tenantId` for symmetry; mismatched bodies are rejected.
// - I5 receipt verifiability: the stored payload+signature shape is
//   returned verbatim; clients re-verify against JWKS.

import type { PromotionReceiptV2, PromotionReceiptV2Payload, PromotionReceiptV2Signature } from '@c3-oss/prosa-types-v2'
import type { BeginPromotionResponse } from '@c3-oss/prosa-wire-v2'
import { bundleHeadV2Schema, segmentRefSchema } from '@c3-oss/prosa-wire-v2'
import { z } from 'zod'
import type { RawExec } from '../../db.js'

export type BeginPromotionDeps = {
  rawExec: RawExec
  tenantId: string
}

export class BeginPromotionValidationError extends Error {
  override name = 'BeginPromotionValidationError'
  constructor(
    message: string,
    readonly issues: unknown,
  ) {
    super(message)
  }
}

export class BeginPromotionTenantMismatchError extends Error {
  override name = 'BeginPromotionTenantMismatchError'
  constructor() {
    super('request tenantId does not match the authenticated tenant')
  }
}

// Server-local request schema. Tenant/store/device ids are opaque on
// the server side (see file header). The bundle and segment refs still
// go through the canonical wire schemas.
const opaqueIdSchema = z.string().min(1)

const serverBeginPromotionRequestSchema = z.object({
  protocolVersion: z.literal(2),
  tenantId: opaqueIdSchema,
  storeId: opaqueIdSchema,
  storePath: z.string(),
  head: bundleHeadV2Schema.extend({
    // Override the canonical storeId on the head with the same opaque
    // form so client bundle stores keyed by Better Auth org ids parse.
    storeId: opaqueIdSchema,
  }),
  inventories: z.object({
    objectInventorySegment: segmentRefSchema,
    projectionInventorySegment: segmentRefSchema,
  }),
  device: z.object({
    deviceId: opaqueIdSchema,
  }),
})

type ServerBeginPromotionRequest = z.infer<typeof serverBeginPromotionRequestSchema>

type RemoteAuthorityRow = { current_receipt_id: string }
type ReceiptRow = { payload: unknown; signature: unknown }

export async function beginPromotion(deps: BeginPromotionDeps, rawInput: unknown): Promise<BeginPromotionResponse> {
  const parsed = serverBeginPromotionRequestSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new BeginPromotionValidationError('invalid BeginPromotion request', parsed.error.issues)
  }
  const input: ServerBeginPromotionRequest = parsed.data

  // I1 sanity check: the wire `tenantId` must match the authenticated
  // tenant. A mismatched body is treated as a request error; the server
  // still uses `ctx.tenantId` for all queries.
  if (input.tenantId !== deps.tenantId) {
    throw new BeginPromotionTenantMismatchError()
  }

  // Cross-check: the body `head.storeId` must match the top-level
  // `storeId`. The schemas do not enforce this; the authority lookup
  // uses the top-level value.
  if (input.head.storeId !== input.storeId) {
    throw new BeginPromotionValidationError('head.storeId must equal request.storeId', [
      { path: ['head', 'storeId'], message: 'mismatch with request.storeId' },
    ])
  }

  // 1. Fast path: already promoted?
  const authority = await deps.rawExec<RemoteAuthorityRow>(
    `SELECT current_receipt_id
       FROM remote_authority_v2
      WHERE tenant_id = $1
        AND store_id = $2
        AND current_bundle_root = $3
      LIMIT 1`,
    [deps.tenantId, input.storeId, input.head.bundleRoot],
  )
  if (authority.length > 0) {
    const receipt = await loadReceipt(deps, authority[0]!.current_receipt_id)
    if (receipt) {
      return { status: 'already_promoted', receipt }
    }
    // Authority row references a missing receipt. This is a server
    // inconsistency — treat as fresh promotion to avoid wedging the
    // client. A separate audit task will heal the orphan.
  }

  // 2. Fresh bundle. Until the staging path lands, surface a
  //    `needs_inventory` placeholder. The promotionId is deterministic
  //    so repeated calls observe the same staging slot; staging row
  //    creation is the next slice.
  const placeholderPromotionId = derivePlaceholderPromotionId(deps.tenantId, input.storeId, input.head.bundleRoot)
  return {
    status: 'needs_inventory',
    promotionId: placeholderPromotionId,
    missingInventories: [input.inventories.objectInventorySegment, input.inventories.projectionInventorySegment],
  }
}

async function loadReceipt(deps: BeginPromotionDeps, receiptId: string): Promise<PromotionReceiptV2 | null> {
  const rows = await deps.rawExec<ReceiptRow>(
    `SELECT payload, signature
       FROM receipt
      WHERE receipt_id = $1
        AND tenant_id = $2
      LIMIT 1`,
    [receiptId, deps.tenantId],
  )
  if (rows.length === 0) return null
  const row = rows[0]!
  const payload = coerceJsonbObject(row.payload) as PromotionReceiptV2Payload | null
  const signature = coerceJsonbObject(row.signature) as PromotionReceiptV2Signature | null
  if (!payload || !signature) return null
  return { payload, signature }
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

// Deterministic placeholder id (`prm_<...>`) so repeated `BeginPromotion`
// calls for the same `(tenant, store, bundleRoot)` quote a stable
// promotion id while the real staging row is still being implemented.
// Uses lowercase hex over a short FNV-1a-64 of the join key to satisfy
// canonicalIdSchema on the response side.
function derivePlaceholderPromotionId(tenantId: string, storeId: string, bundleRoot: string): string {
  const input = `${tenantId} ${storeId} ${bundleRoot}`
  let hash = 0xcbf29ce484222325n
  for (const codeUnit of input) {
    hash ^= BigInt(codeUnit.charCodeAt(0))
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  const hex = hash.toString(16).padStart(16, '0')
  return `prm_${hex}`
}
