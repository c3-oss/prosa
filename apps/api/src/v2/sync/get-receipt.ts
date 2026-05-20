// Lane 5 — GetReceipt handler.
//
// `GET /v2/receipts/:receiptId` is a tenant-scoped lookup used by
// clients that lost the seal response and need to recover the
// receipt before retrying the promotion. The handler reads the
// `receipt` row through the tenant filter and returns
// `{ status: 'found', receipt }` only after proving the row is
// internally consistent and the signature verifies against the
// server signer (CQ-138):
//
// 1. Payload + signature parse to objects.
// 2. `payload.receiptId === :receiptId` — the row id and the
//    signed receipt id agree.
// 3. Row `tenant_id` / `store_id` / `device_id` match the signed
//    `payload.tenantId` / `payload.storeId` / `payload.deviceId`.
// 4. `signer.verifyReceipt(receiptPayloadBytes(payload), signature)`
//    succeeds — the receipt is actually signed by a key in the
//    JWKS.
//
// Any rejection collapses to `{ status: 'not_found', receiptId }`
// rather than a more detailed error: corrupt rows MUST NOT be
// returned to clients as authority, and a more verbose error
// would leak the existence of a malformed receipt to a same-tenant
// caller.

import {
  type PromotionReceiptV2,
  type PromotionReceiptV2Payload,
  type PromotionReceiptV2Signature,
  receiptPayloadBytes,
} from '@c3-oss/prosa-types-v2'
import type { RawExec } from '../../db.js'
import type { ReceiptSigner } from '../signing/local-signer.js'

export type GetReceiptDeps = {
  rawExec: RawExec
  tenantId: string
  signer: ReceiptSigner
}

export type GetReceiptParams = {
  receiptId: string
}

export type GetReceiptResult =
  | { status: 'found'; receipt: PromotionReceiptV2 }
  | { status: 'not_found'; receiptId: string }

type ReceiptRow = {
  payload: unknown
  signature: unknown
  store_id: string
  device_id: string
}

export async function getReceipt(deps: GetReceiptDeps, params: GetReceiptParams): Promise<GetReceiptResult> {
  const rows = await deps.rawExec<ReceiptRow>(
    `SELECT payload, signature, store_id, device_id
       FROM receipt
      WHERE receipt_id = $1 AND tenant_id = $2
      LIMIT 1`,
    [params.receiptId, deps.tenantId],
  )
  if (rows.length === 0) return { status: 'not_found', receiptId: params.receiptId }
  const row = rows[0]!
  const payload = coerceJsonbObject(row.payload) as PromotionReceiptV2Payload | null
  const signature = coerceJsonbObject(row.signature) as PromotionReceiptV2Signature | null
  if (!payload || !signature) return { status: 'not_found', receiptId: params.receiptId }

  // CQ-138 #2: requested id == signed id.
  if (payload.receiptId !== params.receiptId) {
    return { status: 'not_found', receiptId: params.receiptId }
  }
  // CQ-138 #3: row tuple == signed tuple. Same tenant has already
  // matched by the WHERE clause; check the other two columns.
  if (payload.tenantId !== deps.tenantId) {
    return { status: 'not_found', receiptId: params.receiptId }
  }
  if (payload.storeId !== row.store_id || payload.deviceId !== row.device_id) {
    return { status: 'not_found', receiptId: params.receiptId }
  }
  // CQ-138 #4: signature verifies against the JWKS.
  let signatureValid = false
  try {
    signatureValid = await deps.signer.verifyReceipt(receiptPayloadBytes(payload), signature)
  } catch {
    signatureValid = false
  }
  if (!signatureValid) {
    return { status: 'not_found', receiptId: params.receiptId }
  }

  return { status: 'found', receipt: { payload, signature } }
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
