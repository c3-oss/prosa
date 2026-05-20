// Lane 6 / CQ-142 — receipt-snapshot helpers for paginated reads.
//
// Paginated v2 reads must constrain every page to the *same*
// `(store_id, current_receipt_id)` set that was visible on page 1.
// Re-resolving the gate against `remote_authority_v2` on each page
// is unsafe: a promotion between page 1 and page 2 would change
// the visible row set and cause skips, duplicates, or mixed-receipt
// pages.
//
// Each paginated handler:
//
//   1. Resolves the authority snapshot for the tenant on page 1
//      via `resolveAuthoritySnapshot`.
//   2. Composes its WHERE clause using
//      `verifiedProjectionInSnapshotWhere(alias, tenantParam,
//      snapshot, params)` so the gate is bound to the snapshot
//      tuples rather than the live authority table.
//   3. Encodes the snapshot in the page cursor so subsequent pages
//      re-use the same set.
//   4. Decodes the cursor strictly on subsequent pages — a
//      tampered or malformed cursor surfaces as `InvalidCursorError`
//      which the route layer maps to HTTP 400 / `INVALID_CURSOR`.

import type { RawExec } from '../../../db.js'
import { CursorIntegrityError, type CursorSigner } from './cursor-signer.js'

export type AuthoritySnapshotEntry = { storeId: string; receiptId: string }
export type AuthoritySnapshot = readonly AuthoritySnapshotEntry[]

/**
 * Resolve the current `(store_id, current_receipt_id)` pairs for the
 * tenant. The snapshot is taken once per iteration (page 1) and
 * re-used verbatim for subsequent pages.
 */
export async function resolveAuthoritySnapshot(rawExec: RawExec, tenantId: string): Promise<AuthoritySnapshot> {
  const rows = await rawExec<{ store_id: string; current_receipt_id: string }>(
    `SELECT store_id, current_receipt_id
       FROM remote_authority_v2
      WHERE tenant_id = $1
      ORDER BY store_id ASC`,
    [tenantId],
  )
  return rows.map((row) => ({ storeId: row.store_id, receiptId: row.current_receipt_id }))
}

/**
 * Build a WHERE fragment that gates a projection read on the
 * provided authority snapshot rather than the live authority
 * table. Appends positional placeholders to `params` for each
 * `(store_id, receipt_id)` pair.
 *
 * When the snapshot is empty, the predicate evaluates to FALSE so
 * the page returns zero rows without running an `IN ()` (which
 * Postgres treats as a syntax error).
 */
export function verifiedProjectionInSnapshotWhere(
  alias: string,
  tenantParam: string,
  snapshot: AuthoritySnapshot,
  params: unknown[],
): string {
  if (snapshot.length === 0) {
    return `${alias}.tenant_id = ${tenantParam} AND FALSE`
  }
  const tuples = snapshot
    .map((entry) => {
      const s = appendParam(params, entry.storeId)
      const r = appendParam(params, entry.receiptId)
      return `(${s}, ${r})`
    })
    .join(', ')
  return `${alias}.tenant_id = ${tenantParam}
    AND (${alias}.store_id, ${alias}.receipt_id) IN (${tuples})`
}

function appendParam(params: unknown[], value: unknown): string {
  params.push(value)
  return `$${params.length}`
}

/**
 * Thrown by `decodeRequiredCursor` and the snapshot helpers when a
 * client-provided cursor is tampered, truncated, missing the
 * snapshot field, or carries a malformed snapshot entry. The route
 * layer maps it to HTTP 400 / `INVALID_CURSOR`.
 */
export class InvalidCursorError extends Error {
  override name = 'InvalidCursorError'
}

/**
 * Validate a parsed cursor payload's snapshot field. Returns the
 * normalized snapshot or throws `InvalidCursorError` for any
 * tamper / truncation pattern (non-array, wrong entry shape,
 * empty strings).
 */
export function parseCursorSnapshot(raw: unknown): AuthoritySnapshot {
  if (!Array.isArray(raw)) throw new InvalidCursorError('cursor.snapshot must be an array')
  const out: AuthoritySnapshotEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw new InvalidCursorError('cursor.snapshot entry must be an object')
    const r = item as Record<string, unknown>
    if (typeof r.s !== 'string' || r.s.length === 0) throw new InvalidCursorError('cursor.snapshot[].s missing')
    if (typeof r.r !== 'string' || r.r.length === 0) throw new InvalidCursorError('cursor.snapshot[].r missing')
    out.push({ storeId: r.s, receiptId: r.r })
  }
  return out
}

/** Encode an authority snapshot for embedding in a cursor payload. */
export function encodeCursorSnapshot(snapshot: AuthoritySnapshot): Array<{ s: string; r: string }> {
  return snapshot.map((entry) => ({ s: entry.storeId, r: entry.receiptId }))
}

/**
 * Verify + decode a cursor strictly. Returns `null` when the caller
 * passes `null` / `undefined` (first-page semantics). For any
 * malformed or tampered value — bad base64, missing fields, wrong
 * types, HMAC mismatch — it throws `InvalidCursorError`. Cursor
 * integrity (CQ-142 follow-up) is enforced by the supplied
 * `CursorSigner`: the entire payload, including the authority
 * snapshot, is HMAC-signed at encode time and verified here.
 */
export function decodeRequiredCursor<T = Record<string, unknown>>(
  signer: CursorSigner,
  cursor: string | null | undefined,
): T | null {
  if (cursor == null) return null
  // CQ-142 acceptance: an empty-string cursor is NOT first-page
  // semantics. Callers either omit the field entirely (handled
  // above) or pass a server-issued token; an explicit empty string
  // is a forgery / corruption signal and fails closed.
  if (cursor === '') {
    throw new InvalidCursorError('cursor cannot be the empty string')
  }
  let parsed: unknown
  try {
    parsed = signer.verify(cursor)
  } catch (err) {
    if (err instanceof CursorIntegrityError) {
      throw new InvalidCursorError(err.message)
    }
    throw err
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidCursorError('cursor payload must be a JSON object')
  }
  return parsed as T
}

/**
 * Sign + encode a cursor payload. The encoded token includes an
 * HMAC over the payload bytes so any tamper at the client side
 * produces a verification failure.
 */
export function encodeSignedCursor(signer: CursorSigner, payload: Record<string, unknown>): string {
  return signer.sign(payload)
}
