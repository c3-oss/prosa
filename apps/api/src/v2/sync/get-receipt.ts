// Lane 5 — GetReceipt handler.
//
// `GET /v2/receipts/:receiptId` is a tenant-scoped lookup used by
// clients that lost the seal response and need to recover the
// receipt before retrying the promotion. The handler reads the
// `receipt` row through the tenant filter and returns
// `{ status: 'found', receipt }` with the stored payload + signature
// verbatim. Misses — including cross-tenant attempts — produce
// `{ status: 'not_found', receiptId }` with a 404 response code so
// that existence does not leak across tenants (I1).

import type { PromotionReceiptV2, PromotionReceiptV2Payload, PromotionReceiptV2Signature } from '@c3-oss/prosa-types-v2'
import type { RawExec } from '../../db.js'

export type GetReceiptDeps = {
  rawExec: RawExec
  tenantId: string
}

export type GetReceiptParams = {
  receiptId: string
}

export type GetReceiptResult =
  | { status: 'found'; receipt: PromotionReceiptV2 }
  | { status: 'not_found'; receiptId: string }

type ReceiptRow = { payload: unknown; signature: unknown }

export async function getReceipt(deps: GetReceiptDeps, params: GetReceiptParams): Promise<GetReceiptResult> {
  const rows = await deps.rawExec<ReceiptRow>(
    `SELECT payload, signature
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
