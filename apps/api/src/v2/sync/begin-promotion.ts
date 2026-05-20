// Lane 5 — BeginPromotion handler.
//
// Implements the no-op fast path against an already-promoted bundle
// AND the staging-row open path for fresh bundles:
//
// - When `(tenant_id, store_id, current_bundle_root)` exists in
//   `remote_authority_v2`, fetch the matching receipt row and return
//   `{ status: 'already_promoted', receipt }`.
// - Else, find or insert a `promotion_staging` row for the same
//   `(tenant_id, store_id, bundleRoot)` and return its id with
//   `{ status: 'needs_inventory', promotionId, missingInventories }`.
//   Idempotent under retries: a second call with the same join key
//   returns the same `promotionId` and does NOT insert a duplicate.
//
// Real inventory/object presence detection (the `needs_upload`
// transition) is deferred to the slice that wires the segment + object
// pack upload routes.
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
// CQ-123 tracks the broader receipt-side mismatch.
//
// Invariants enforced here:
// - I1 tenant isolation: every query filters by `ctx.tenantId`. The body
//   `tenantId` is a client-side sanity check and is compared to
//   `ctx.tenantId` for symmetry; mismatched bodies are rejected.
// - I5 receipt verifiability: the stored payload+signature shape is
//   returned verbatim; clients re-verify against JWKS.

import { randomBytes } from 'node:crypto'
import type { PromotionReceiptV2, PromotionReceiptV2Payload, PromotionReceiptV2Signature } from '@c3-oss/prosa-types-v2'
import type { BeginPromotionResponse } from '@c3-oss/prosa-wire-v2'
import { bundleHeadV2Schema, segmentRefSchema } from '@c3-oss/prosa-wire-v2'
import { z } from 'zod'
import type { RawExec } from '../../db.js'

export type BeginPromotionDeps = {
  rawExec: RawExec
  tenantId: string
  userId: string
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

// CQ-125: a `remote_authority_v2` row pointing at a missing or
// tuple-mismatched receipt is corrupt server state. The fast path
// MUST NOT silently reopen promotion — that would mask catalog
// drift behind a needs_inventory response. Refuse to serve until
// an operator/audit task heals the orphan.
export class BeginPromotionAuthorityCorruptError extends Error {
  override name = 'BeginPromotionAuthorityCorruptError'
  readonly code = 'AUTHORITY_CORRUPT' as const
}

// CQ-127: the request's deviceId is already registered to a
// different user in the same tenant — refuse with a documented
// device-ownership error rather than auto-claiming.
export class BeginPromotionDeviceOwnershipError extends Error {
  override name = 'BeginPromotionDeviceOwnershipError'
  readonly code = 'DEVICE_OWNED_BY_OTHER_USER' as const
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
type StagingRow = { id: string; status: string }

// Promotion_staging statuses that represent an in-flight slot. A row
// with status='sealed' is terminal-success; 'aborted' is
// terminal-failure. Both must be ignored when looking up an active
// slot for the same (tenant, store, bundleRoot) join key — a new
// promotion should open a fresh slot rather than resurrect a closed
// one.
const ACTIVE_STAGING_STATUSES = ['open', 'uploading', 'materializing'] as const

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

  // CQ-127: claim the device for this user before any catalog
  // read returns receipt metadata. The device record is the
  // authorization handle used by upload/seal/get-receipt; the
  // claim is `INSERT ON CONFLICT DO NOTHING` so repeated
  // BeginPromotion calls from the same device are idempotent,
  // and a steal attempt (different user owning the same id)
  // surfaces as `DEVICE_OWNED_BY_OTHER_USER`.
  await claimDevice(deps, input.device.deviceId)

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
    // CQ-125: load the receipt scoped to the same authority tuple
    // and verify the loaded row + signed payload BOTH match the
    // requested store/bundleRoot/tenant. A mismatch (or a missing
    // receipt for a present authority row) is corrupt state — fail
    // closed rather than silently reopen the promotion.
    const loaded = await loadAuthorityReceipt(deps, {
      receiptId: authority[0]!.current_receipt_id,
      storeId: input.storeId,
      bundleRoot: input.head.bundleRoot,
    })
    if (loaded === 'missing' || loaded === 'mismatch') {
      throw new BeginPromotionAuthorityCorruptError(
        `remote_authority_v2 row for (${deps.tenantId}, ${input.storeId}, ${input.head.bundleRoot}) references a ${loaded === 'missing' ? 'missing' : 'tuple-mismatched'} receipt`,
      )
    }
    // CQ-127: only return the receipt to the device that actually
    // sealed it. A different device in the same tenant falls
    // through to open its own staging slot (the bundle's
    // authority already exists — a re-seal from this device will
    // produce a fresh receipt the device can trust).
    if (loaded.payload.deviceId === input.device.deviceId) {
      return { status: 'already_promoted', receipt: loaded }
    }
  }

  // 2. Open (or reuse) a promotion_staging row for this bundle.
  const promotionId = await findOrCreateStaging(deps, input)

  return {
    status: 'needs_inventory',
    promotionId,
    missingInventories: [input.inventories.objectInventorySegment, input.inventories.projectionInventorySegment],
  }
}

async function findOrCreateStaging(deps: BeginPromotionDeps, input: ServerBeginPromotionRequest): Promise<string> {
  // Idempotent lookup: an active staging row for the same
  // (tenant, store, bundleRoot) wins. We compare bundleRoot through
  // the JSONB head column so the lookup is exact even when the
  // `head_json` payload changes across calls (e.g. counts differ).
  const existing = await deps.rawExec<StagingRow>(
    `SELECT id, status
       FROM promotion_staging
      WHERE tenant_id = $1
        AND store_id = $2
        AND head_json->>'bundleRoot' = $3
        AND status = ANY($4)
      ORDER BY created_at DESC
      LIMIT 1`,
    [deps.tenantId, input.storeId, input.head.bundleRoot, ACTIVE_STAGING_STATUSES as unknown as string[]],
  )
  if (existing.length > 0) {
    return existing[0]!.id
  }

  // CQ-128: race-safe fresh insert. The partial unique index
  // `promotion_staging_active_tuple_idx` over
  // `(tenant_id, store_id, head_json->>'bundleRoot')` filtered on
  // ACTIVE statuses guarantees at most one open slot per tuple.
  // Two concurrent BeginPromotion calls that observe an empty
  // SELECT both race on the INSERT; the loser hits `ON CONFLICT DO
  // NOTHING` and the follow-up SELECT returns the winner's id.
  //
  // `prm_<base32-lower>` id satisfies `canonicalIdSchema` on the
  // response side so the wire contract holds for promotionId.
  const promotionId = newPromotionId()
  const inserted = await deps.rawExec<{ id: string }>(
    `INSERT INTO promotion_staging (
       id, tenant_id, user_id, device_id, store_id, store_path,
       status, head_json, inventory_object_ref, inventory_projection_ref
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7::jsonb, $8, $9)
     ON CONFLICT (tenant_id, store_id, (head_json->>'bundleRoot'))
       WHERE status IN ('open', 'uploading', 'materializing')
       DO NOTHING
     RETURNING id`,
    [
      promotionId,
      deps.tenantId,
      deps.userId,
      input.device.deviceId,
      input.storeId,
      input.storePath,
      JSON.stringify(input.head),
      JSON.stringify(input.inventories.objectInventorySegment),
      JSON.stringify(input.inventories.projectionInventorySegment),
    ],
  )
  if (inserted.length > 0) {
    return inserted[0]!.id
  }

  // Lost the race. The winner's row is now visible via the same
  // active-tuple lookup we ran above; return its id.
  const winner = await deps.rawExec<StagingRow>(
    `SELECT id, status
       FROM promotion_staging
      WHERE tenant_id = $1
        AND store_id = $2
        AND head_json->>'bundleRoot' = $3
        AND status = ANY($4)
      ORDER BY created_at DESC
      LIMIT 1`,
    [deps.tenantId, input.storeId, input.head.bundleRoot, ACTIVE_STAGING_STATUSES as unknown as string[]],
  )
  if (winner.length === 0) {
    // Window where the unique-index conflict matched but the row is
    // not yet visible (or has already terminated). Surface a typed
    // error so the caller retries.
    throw new BeginPromotionValidationError('failed to resolve staging slot after conflict', [
      { path: ['promotion'], message: 'staging slot race did not settle on a winner' },
    ])
  }
  return winner[0]!.id
}

// CQ-127: claim a device for (tenant_id, user_id). The first
// BeginPromotion from a fresh device auto-registers it; repeated
// calls from the same device are a no-op. A different user
// claiming the same id surfaces as DEVICE_OWNED_BY_OTHER_USER.
async function claimDevice(deps: BeginPromotionDeps, deviceId: string): Promise<void> {
  const existing = await deps.rawExec<{ user_id: string }>(
    `SELECT user_id FROM device WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [deviceId, deps.tenantId],
  )
  if (existing.length > 0) {
    if (existing[0]!.user_id !== deps.userId) {
      throw new BeginPromotionDeviceOwnershipError(
        `device ${deviceId} is already registered to another user in this tenant`,
      )
    }
    return
  }
  // Auto-register. The v1 `device` table schema is what the test
  // helper + production both apply; the v2 device columns
  // overlap on (id, tenant_id, user_id, name, platform,
  // cli_version, created_at). `name` defaults to the deviceId so
  // the column stays NOT NULL without forcing the client to
  // supply one for v2.0.
  await deps.rawExec(
    `INSERT INTO device (id, tenant_id, user_id, name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [deviceId, deps.tenantId, deps.userId, deviceId],
  )
}

// CQ-125: load the receipt referenced by an authority row and
// prove it matches the expected (store, bundleRoot) tuple on
// BOTH the row columns (store_id) and the signed payload
// (storeId / bundleRoot / tenantId). Returns:
//   - 'missing' when the receipt row is gone or has malformed
//     payload/signature JSONB,
//   - 'mismatch' when the row or payload disagrees with the
//     expected tuple,
//   - the receipt otherwise.
async function loadAuthorityReceipt(
  deps: BeginPromotionDeps,
  opts: { receiptId: string; storeId: string; bundleRoot: string },
): Promise<PromotionReceiptV2 | 'missing' | 'mismatch'> {
  const rows = await deps.rawExec<ReceiptRow & { row_store_id: string }>(
    `SELECT payload, signature, store_id AS row_store_id
       FROM receipt
      WHERE receipt_id = $1
        AND tenant_id = $2
      LIMIT 1`,
    [opts.receiptId, deps.tenantId],
  )
  if (rows.length === 0) return 'missing'
  const row = rows[0]!
  const payload = coerceJsonbObject(row.payload) as PromotionReceiptV2Payload | null
  const signature = coerceJsonbObject(row.signature) as PromotionReceiptV2Signature | null
  if (!payload || !signature) return 'missing'
  if (row.row_store_id !== opts.storeId) return 'mismatch'
  if (payload.tenantId !== deps.tenantId) return 'mismatch'
  if (payload.storeId !== opts.storeId) return 'mismatch'
  if (payload.bundleRoot !== opts.bundleRoot) return 'mismatch'
  if (payload.receiptId !== opts.receiptId) return 'mismatch'
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

// `prm_<26-char-base32-lower>` — 130 random bits, satisfies
// canonicalIdSchema (lowercase alnum prefix + `[a-z0-9_:-]`). Base32
// alphabet excludes `-`/`_`, so the result is purely [a-z2-7].
const BASE32_LOWER = 'abcdefghijklmnopqrstuvwxyz234567'

function newPromotionId(): string {
  const bytes = randomBytes(16)
  let out = 'prm_'
  for (const byte of bytes) {
    // Two base32 chars per byte (8 high bits + 8 low). 16 bytes →
    // 32 chars; we truncate to 26 to keep ids compact.
    out += BASE32_LOWER[byte >> 3]
    out += BASE32_LOWER[((byte & 0b111) << 2) % 32]
  }
  return out.slice(0, 30)
}
