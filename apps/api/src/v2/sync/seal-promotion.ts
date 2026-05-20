// Lane 5 — SealPromotion handler.
//
// `POST /v2/promotions/:promotionId/seal` is the load-bearing
// authority-swap. The seal path is the ONLY code path that writes
// `remote_authority_v2`, `search_generation_current`, or
// `receipt_pack_grant` rows (Lane 5 gate L5.6, enforced by review).
//
// Sequence:
//
// 1. Look up the `promotion_staging` row by `(id, tenant_id)`. Miss
//    or `aborted` → 404. Already `sealed` → idempotent return of the
//    existing receipt. `materializing` (an in-flight seal from
//    another worker) → 409 SEAL_IN_PROGRESS.
// 2. Verify both inventory segments are present in the object store
//    (`staging/<tenant>/<promotion>/<segmentId>`). Missing → 409
//    INVENTORY_INCOMPLETE.
// 3. Atomically flip status to `materializing`. The CAS guards
//    against a second concurrent seal: only the worker that observed
//    status `open`/`uploading` proceeds. The CAS uses a `RETURNING`
//    update so we get a row count back.
// 4. Read the per-promotion pack list from
//    `promotion_uploaded_pack` (slice 4 maintains this linkage).
// 5. Build a `PromotionReceiptV2Payload`. Counts come from the
//    bundle head; materialization row counts are all zero because
//    projection materialization is deferred to Lane 6 (CQ-124
//    blocks shared-name table writes until cutover). The
//    `materialization.searchGenerationId` is derived from
//    `(tenantId, storeId, bundleRoot)` so it's stable across
//    retries.
// 6. Sign `receiptPayloadBytes(payload)` with the configured signer.
// 7. ONE Postgres transaction:
//    - INSERT receipt row
//    - UPSERT remote_authority_v2
//    - UPSERT search_generation_current
//    - INSERT one receipt_pack_grant per uploaded pack
//    - UPDATE promotion_staging status='sealed'
// 8. Return `{ status: 'sealed', receipt }`.

import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import {
  CANONICAL_ENTITY_TYPES,
  type CanonicalEntityType,
  type PromotionReceiptV2,
  type PromotionReceiptV2Payload,
  type PromotionReceiptV2Signature,
  deriveReceiptId,
  receiptPayloadBytes,
} from '@c3-oss/prosa-types-v2'
import { blake3 } from '@noble/hashes/blake3'
import type { DatabaseHandle, RawExec } from '../../db.js'
import type { ReceiptSigner } from '../signing/local-signer.js'
import { stagingObjectKey } from './upload-segment.js'

export type SealPromotionDeps = {
  rawExec: RawExec
  transaction: DatabaseHandle['transaction']
  tenantId: string
  objectStore: RemoteObjectStore
  signer: ReceiptSigner
  /** Server region label embedded in the receipt payload. */
  serverRegion?: string
}

export type SealPromotionParams = {
  promotionId: string
}

export type SealPromotionResult = {
  status: 'sealed'
  receipt: PromotionReceiptV2
}

export class SealPromotionNotFoundError extends Error {
  override name = 'SealPromotionNotFoundError'
  readonly code = 'PROMOTION_NOT_FOUND' as const
}

export class SealPromotionInProgressError extends Error {
  override name = 'SealPromotionInProgressError'
  readonly code = 'SEAL_IN_PROGRESS' as const
}

export class SealPromotionInventoryIncompleteError extends Error {
  override name = 'SealPromotionInventoryIncompleteError'
  readonly code = 'INVENTORY_INCOMPLETE' as const
  constructor(readonly missingSegmentIds: readonly string[]) {
    super(`missing inventory segments: ${missingSegmentIds.join(', ')}`)
  }
}

// CQ-136: corrupt re-seal linkage — `sealed_receipt_id` points
// at a receipt whose signed tuple disagrees with the staging
// row's (store, device, bundleRoot). Treated as server-side
// corruption: fail closed instead of returning the wrong
// receipt.
export class SealPromotionLinkCorruptError extends Error {
  override name = 'SealPromotionLinkCorruptError'
  readonly code = 'SEAL_LINK_CORRUPT' as const
}

// CQ-134: the bundle head's declared object count must be covered
// by the union of `remote_pack_entry` rows for packs uploaded in
// this promotion. Refuse to swap authority when the catalog falls
// short; the spec calls this a "promoted data not proven" failure.
export class SealPromotionCoverageError extends Error {
  override name = 'SealPromotionCoverageError'
  readonly code = 'OBJECT_COVERAGE_INCOMPLETE' as const
  constructor(
    readonly declaredObjectCount: number,
    readonly catalogObjectCount: number,
  ) {
    super(
      `bundle declares ${declaredObjectCount} objects, ` +
        `but only ${catalogObjectCount} remote_pack_entry rows are linked to this promotion`,
    )
  }
}

type StagingRow = {
  status: string
  user_id: string
  device_id: string
  store_id: string
  store_path: string
  head_json: unknown
  inventory_object_ref: unknown
  inventory_projection_ref: unknown
  sealed_receipt_id: string | null
}

type ReceiptRow = { payload: unknown; signature: unknown }

const ACTIVE_STAGING = ['open', 'uploading'] as const
const ZERO_BUNDLE_HASH = '0'.repeat(64)

export async function sealPromotion(
  deps: SealPromotionDeps,
  params: SealPromotionParams,
): Promise<SealPromotionResult> {
  const stagingRows = await deps.rawExec<StagingRow>(
    `SELECT status, user_id, device_id, store_id, store_path, head_json,
            inventory_object_ref, inventory_projection_ref, sealed_receipt_id
       FROM promotion_staging
      WHERE id = $1 AND tenant_id = $2
      LIMIT 1`,
    [params.promotionId, deps.tenantId],
  )
  if (stagingRows.length === 0) {
    throw new SealPromotionNotFoundError(`promotion ${params.promotionId} not found`)
  }
  const staging = stagingRows[0]!

  if (staging.status === 'aborted') {
    throw new SealPromotionNotFoundError(`promotion ${params.promotionId} is aborted`)
  }
  if (staging.status === 'materializing') {
    throw new SealPromotionInProgressError(`promotion ${params.promotionId} is mid-seal`)
  }
  if (staging.status === 'sealed') {
    // CQ-136: idempotent re-seal must return the receipt this
    // promotion actually sealed AND verify the linked receipt
    // belongs to this staging row's (store, device, bundle)
    // tuple. A corrupt link (e.g. a tampered
    // `sealed_receipt_id` pointing at a same-tenant receipt for
    // a different store/device) MUST fail closed rather than
    // return the wrong receipt.
    if (staging.sealed_receipt_id) {
      const existing = await loadReceiptById(deps, staging.sealed_receipt_id)
      if (existing) {
        const head = coerceHead(staging.head_json)
        const tupleMatch =
          existing.payload.tenantId === deps.tenantId &&
          existing.payload.storeId === staging.store_id &&
          existing.payload.deviceId === staging.device_id &&
          existing.payload.receiptId === staging.sealed_receipt_id &&
          head !== null &&
          existing.payload.bundleRoot === head.bundleRoot
        if (tupleMatch) {
          return { status: 'sealed', receipt: existing }
        }
        // Linked receipt doesn't match the staging tuple — refuse
        // rather than reopen seal or return the wrong receipt.
        throw new SealPromotionLinkCorruptError(
          `sealed_receipt_id ${staging.sealed_receipt_id} on promotion ${params.promotionId} does not match the staging tuple`,
        )
      }
    }
    // Fall through if the linkage is missing or the receipt row
    // disappeared — let the re-seal attempt restore it.
  }

  // Inventory presence check.
  const objectInventoryRef = parseSegmentId(staging.inventory_object_ref)
  const projectionInventoryRef = parseSegmentId(staging.inventory_projection_ref)
  const missing: string[] = []
  if (objectInventoryRef === null) missing.push('object-inventory')
  if (projectionInventoryRef === null) missing.push('projection-inventory')
  if (missing.length === 0) {
    for (const segmentId of [objectInventoryRef!, projectionInventoryRef!]) {
      const key = stagingObjectKey(deps.tenantId, params.promotionId, segmentId)
      const head = await deps.objectStore.head(key)
      if (!head) missing.push(segmentId)
    }
  }
  if (missing.length > 0) {
    throw new SealPromotionInventoryIncompleteError(missing)
  }

  // CAS status flip: open|uploading → materializing. The RETURNING
  // count tells us whether we won the race.
  const flipped = await deps.rawExec<{ id: string }>(
    `UPDATE promotion_staging
        SET status = 'materializing', updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND status = ANY($3)
      RETURNING id`,
    [params.promotionId, deps.tenantId, ACTIVE_STAGING as unknown as string[]],
  )
  if (flipped.length === 0) {
    // Someone else flipped first. Re-read.
    const refreshed = await deps.rawExec<{ status: string; sealed_receipt_id: string | null }>(
      `SELECT status, sealed_receipt_id FROM promotion_staging WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [params.promotionId, deps.tenantId],
    )
    if (refreshed[0]?.status === 'sealed' && refreshed[0]!.sealed_receipt_id) {
      const existing = await loadReceiptById(deps, refreshed[0]!.sealed_receipt_id)
      if (existing) return { status: 'sealed', receipt: existing }
    }
    throw new SealPromotionInProgressError(`promotion ${params.promotionId} is mid-seal`)
  }

  // CQ-135: every step after the status flip is wrapped so the
  // slot is restored from `materializing` back to its prior
  // status (open / uploading) on ANY failure — signer outages,
  // payload-building bugs, transaction errors, schema drift.
  // The previous closure only wrapped the signer + transaction;
  // the reviewer flagged that pack lookup / currentKeyId /
  // receiptPayloadBytes / buildReceiptPayload can also throw
  // after the flip. This try-block restores on every code path
  // that runs post-flip but before the transaction body.
  let finalPayload: PromotionReceiptV2Payload
  let signature: PromotionReceiptV2Signature
  let packDigests: string[]
  let bundleRoot: string
  try {
    // Look up uploaded packs for this promotion.
    const packRows = await deps.rawExec<{ pack_digest: string }>(
      `SELECT pack_digest FROM promotion_uploaded_pack
        WHERE promotion_id = $1 AND tenant_id = $2`,
      [params.promotionId, deps.tenantId],
    )
    packDigests = packRows.map((r) => r.pack_digest)

    // Build receipt payload.
    const head = coerceHead(staging.head_json)
    if (!head) {
      throw new SealPromotionNotFoundError(`promotion ${params.promotionId} has malformed head`)
    }
    bundleRoot = head.bundleRoot

    // CQ-134: prove every declared object is covered by a
    // `remote_pack_entry` row linked to this promotion BEFORE we
    // swap authority. Falling short means the remote cannot
    // replace local data — the receipt would be a cleanup signal
    // for bytes the server can't actually serve.
    const declaredObjectCount = head.counts.objects
    if (declaredObjectCount > 0) {
      const coverageRows = await deps.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count
           FROM remote_pack_entry rpe
           JOIN promotion_uploaded_pack pup
             ON pup.pack_digest = rpe.pack_digest AND pup.tenant_id = rpe.tenant_id
          WHERE pup.promotion_id = $1 AND pup.tenant_id = $2`,
        [params.promotionId, deps.tenantId],
      )
      const catalogObjectCount = Number(coverageRows[0]?.count ?? 0)
      if (catalogObjectCount < declaredObjectCount) {
        throw new SealPromotionCoverageError(declaredObjectCount, catalogObjectCount)
      }
    }

    const payload = buildReceiptPayload({
      tenantId: deps.tenantId,
      storeId: staging.store_id,
      storePath: staging.store_path,
      deviceId: staging.device_id,
      bundleRoot: head.bundleRoot,
      rawSourceRoot: head.rawSourceRoot,
      counts: head.counts,
      serverRegion: deps.serverRegion ?? 'local',
      serverKeyId: deps.signer.currentKeyId(),
      issuedAt: canonicalNowMs(),
      previousReceiptId: null,
      previousBundleRoot: null,
      searchGenerationId: deriveSearchGenerationId(deps.tenantId, staging.store_id, head.bundleRoot),
      postgresCommitId: derivePostgresCommitId(deps.tenantId, staging.store_id, head.bundleRoot),
    })
    const receiptIdAttempt = deriveReceiptId(payload)
    finalPayload = { ...payload, receiptId: receiptIdAttempt }
    const signatureBytes = receiptPayloadBytes(finalPayload)
    signature = await deps.signer.signReceipt(signatureBytes)
  } catch (err) {
    // Restore the slot so the client can retry once the
    // underlying issue clears. `restoreStagingStatus` only
    // reverts rows still in `materializing`; if a racing seal
    // already terminated this slot, we leave its final state
    // intact.
    await restoreStagingStatus(deps, params.promotionId, staging.status)
    throw err
  }

  // The load-bearing transaction.
  try {
    await deps.transaction(async (tx) => {
      await tx(
        `INSERT INTO receipt (receipt_id, tenant_id, store_id, device_id, payload, signature)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [
          finalPayload.receiptId,
          deps.tenantId,
          staging.store_id,
          staging.device_id,
          JSON.stringify(finalPayload),
          JSON.stringify(signature),
        ],
      )
      await tx(
        `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id, store_id) DO UPDATE
         SET current_receipt_id = EXCLUDED.current_receipt_id,
             current_bundle_root = EXCLUDED.current_bundle_root,
             promoted_at = EXCLUDED.promoted_at`,
        [deps.tenantId, staging.store_id, finalPayload.receiptId, bundleRoot],
      )
      // CQ-137: search_generation_current is keyed by
      // (tenant_id, store_id) — promoting a second store in the
      // same tenant must not clobber the first store's generation.
      await tx(
        `INSERT INTO search_generation_current (tenant_id, store_id, generation_id, receipt_id, promoted_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id, store_id) DO UPDATE
         SET generation_id = EXCLUDED.generation_id,
             receipt_id = EXCLUDED.receipt_id,
             promoted_at = EXCLUDED.promoted_at,
             updated_at = now()`,
        [deps.tenantId, staging.store_id, finalPayload.materialization.searchGenerationId, finalPayload.receiptId],
      )
      for (const digest of packDigests) {
        await tx(
          `INSERT INTO receipt_pack_grant (receipt_id, tenant_id, pack_digest, grant_mode)
         VALUES ($1, $2, $3, 'all_entries')
         ON CONFLICT (receipt_id, tenant_id, pack_digest) DO NOTHING`,
          [finalPayload.receiptId, deps.tenantId, digest],
        )
      }
      await tx(
        `UPDATE promotion_staging
            SET status = 'sealed',
                sealed_receipt_id = $3,
                updated_at = now()
          WHERE id = $1 AND tenant_id = $2`,
        [params.promotionId, deps.tenantId, finalPayload.receiptId],
      )
    })
  } catch (err) {
    // CQ-135: transaction-level failure (e.g. unique violation,
    // Postgres connection drop) must restore the slot so a retry can
    // re-attempt the seal. The transaction itself rolled everything
    // back; only the prior status flip survives outside the tx.
    await restoreStagingStatus(deps, params.promotionId, staging.status)
    throw err
  }

  return { status: 'sealed', receipt: { payload: finalPayload, signature } }
}

async function restoreStagingStatus(deps: SealPromotionDeps, promotionId: string, priorStatus: string): Promise<void> {
  // Only revert when the row is still mid-flight; if another seal
  // attempt already completed, leave the sealed/aborted final state
  // intact.
  const safeStatus = priorStatus === 'open' || priorStatus === 'uploading' ? priorStatus : 'open'
  await deps.rawExec(
    `UPDATE promotion_staging
        SET status = $3, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND status = 'materializing'`,
    [promotionId, deps.tenantId, safeStatus],
  )
}

async function loadReceiptById(deps: SealPromotionDeps, receiptId: string): Promise<PromotionReceiptV2 | null> {
  // CQ-136: load the exact receipt this promotion sealed, not
  // whatever happens to be the store's current authority. Caller
  // resolves `receiptId` from `promotion_staging.sealed_receipt_id`.
  const rows = await deps.rawExec<ReceiptRow>(
    `SELECT payload, signature
       FROM receipt
      WHERE receipt_id = $1 AND tenant_id = $2
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

function buildReceiptPayload(input: {
  tenantId: string
  storeId: string
  storePath: string
  deviceId: string
  bundleRoot: string
  rawSourceRoot: string
  counts: PromotionReceiptV2Payload['counts']
  serverRegion: string
  serverKeyId: string
  issuedAt: string
  previousReceiptId: string | null
  previousBundleRoot: string | null
  searchGenerationId: string
  postgresCommitId: string
}): PromotionReceiptV2Payload {
  const rowCountsByEntity = Object.fromEntries(CANONICAL_ENTITY_TYPES.map((t) => [t, 0])) as Record<
    CanonicalEntityType,
    number
  >
  return {
    receiptVersion: 2,
    receiptId: 'rcpt_placeholder',
    protocolVersion: 2,
    tenantId: input.tenantId,
    storeId: input.storeId,
    storePath: input.storePath,
    deviceId: input.deviceId,
    issuedAt: input.issuedAt,
    serverRegion: input.serverRegion,
    serverKeyId: input.serverKeyId,
    previousReceiptId: input.previousReceiptId,
    previousBundleRoot: input.previousBundleRoot,
    bundleRoot: input.bundleRoot,
    rawSourceRoot: input.rawSourceRoot,
    counts: input.counts,
    materialization: {
      postgresCommitId: input.postgresCommitId,
      searchGenerationId: input.searchGenerationId,
      rowCountsByEntity,
    },
    verification: {
      uploadDigestVerified: true,
      objectHashesVerifiedAtIngest: true,
      projectionRowsLoaded: true,
      noPerObjectHeadRequired: true,
      backgroundAuditEligible: true,
    },
    clientSignatureStatus: 'absent_v2_0',
  }
}

function canonicalNowMs(): string {
  const d = new Date()
  // Canonical RFC3339 UTC ms — yyyy-MM-ddTHH:mm:ss.SSSZ.
  return `${d.getUTCFullYear().toString().padStart(4, '0')}-${(d.getUTCMonth() + 1).toString().padStart(2, '0')}-${d
    .getUTCDate()
    .toString()
    .padStart(2, '0')}T${d.getUTCHours().toString().padStart(2, '0')}:${d
    .getUTCMinutes()
    .toString()
    .padStart(
      2,
      '0',
    )}:${d.getUTCSeconds().toString().padStart(2, '0')}.${d.getUTCMilliseconds().toString().padStart(3, '0')}Z`
}

function deriveSearchGenerationId(tenantId: string, storeId: string, bundleRoot: string): string {
  return `gen_${toHex(blake3(new TextEncoder().encode(`${tenantId}|${storeId}|${bundleRoot}`))).slice(0, 16)}`
}

function derivePostgresCommitId(tenantId: string, storeId: string, bundleRoot: string): string {
  return `pgc_${toHex(blake3(new TextEncoder().encode(`commit|${tenantId}|${storeId}|${bundleRoot}`))).slice(0, 16)}`
}

function parseSegmentId(raw: unknown): string | null {
  const obj = coerceJsonbObject(raw)
  if (!obj) return null
  const id = (obj as { segmentId?: unknown }).segmentId
  return typeof id === 'string' ? id : null
}

type HeadShape = {
  bundleRoot: string
  rawSourceRoot: string
  counts: PromotionReceiptV2Payload['counts']
}

function coerceHead(raw: unknown): HeadShape | null {
  const obj = coerceJsonbObject(raw)
  if (!obj) return null
  const bundleRoot = (obj as { bundleRoot?: unknown }).bundleRoot
  const rawSourceRoot = (obj as { rawSourceRoot?: unknown }).rawSourceRoot ?? ZERO_BUNDLE_HASH
  const counts = (obj as { counts?: unknown }).counts
  if (typeof bundleRoot !== 'string' || typeof rawSourceRoot !== 'string') return null
  if (!counts || typeof counts !== 'object') return null
  return {
    bundleRoot,
    rawSourceRoot,
    counts: counts as PromotionReceiptV2Payload['counts'],
  }
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

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}
