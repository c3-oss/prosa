// Lane 6 — authority refresh handler.
//
// `GET /v2/stores/:storeId/authority?knownReceiptId=...` returns the
// caller's current authority for a store. Responses:
//
//   - `{ status: 'unchanged', receiptId, expiresAt, auditStatus }` —
//     the caller already knows the current receipt id.
//   - `{ status: 'updated', receipt, expiresAt, auditStatus }` —
//     the server's current receipt differs from the caller's known
//     id; the receipt is returned so the caller can replace its
//     local copy.
//   - `{ status: 'gone_or_forbidden' }` — there is no authority for
//     this `(tenant, store)` for the caller. Same shape covers both
//     "tenant lost membership" and "store has never been promoted"
//     so the route never reveals existence to an unauthorized caller.
//
// The handler is tenant scoped: the auth context's `tenantId` is the
// only one consulted; the request never trusts an attacker-supplied
// tenant header for the authority lookup. The 30 s in-process cache
// keyed on `(tenant_id, store_id)` produces at most one Postgres
// query per TTL window per process.

import type { PromotionReceiptV2 } from '@c3-oss/prosa-types-v2'
import type { RawExec } from '../../db.js'
import { type AuthorityTtlCache, authorityCacheKey } from './authority-cache.js'

export type AuthorityAuditStatus = 'ok' | 'audit_pending' | 'drift' | 'quarantined'

/**
 * Lane 8 repair hint. Surfaced on `unchanged` / `updated` responses
 * whenever the receipt has an entry in `receipt_audit_state` with a
 * non-`ok` status. The CLI / web layer uses this to suggest a
 * re-promotion to the operator.
 */
export type AuthorityRepairHint = {
  kind: 're_promote_requested'
  reason: 'missing_pack' | 'hash_mismatch' | 'invalidated'
  affectedReceiptId: string
  affectedPackCount: number
  message: string
}

export type AuthorityRefreshResponse =
  | {
      status: 'unchanged'
      receiptId: string
      expiresAt: string
      auditStatus: AuthorityAuditStatus
      repair?: AuthorityRepairHint
    }
  | {
      status: 'updated'
      receipt: PromotionReceiptV2
      expiresAt: string
      auditStatus: AuthorityAuditStatus
      repair?: AuthorityRepairHint
    }
  | { status: 'gone_or_forbidden' }

export type CachedAuthority = {
  receiptId: string
  receipt: PromotionReceiptV2
  auditStatus: AuthorityAuditStatus
  repair?: AuthorityRepairHint
}

export type GetAuthorityDeps = {
  rawExec: RawExec
  cache: AuthorityTtlCache<CachedAuthority>
  /** Override for tests; defaults to `Date.now()`. */
  now?: () => number
}

export type GetAuthorityInput = {
  tenantId: string
  storeId: string
  knownReceiptId: string | null
}

type AuthorityRow = {
  current_receipt_id: string
  payload: unknown
  signature: unknown
  store_pack_status: string | null
  receipt_audit_status: string | null
  receipt_audit_pack_count: string | number | null
}

export async function getAuthority(
  deps: GetAuthorityDeps,
  input: GetAuthorityInput,
): Promise<AuthorityRefreshResponse> {
  const now = (deps.now ?? Date.now)()
  const key = authorityCacheKey(input.tenantId, input.storeId)
  const cached = deps.cache.get(key, now)
  if (cached) {
    return respondFromCache(cached.value, cached.expiresAt, input.knownReceiptId)
  }

  // Single round-trip: join `remote_authority_v2` to the signed
  // receipt and to the worst-status pack audit row for the receipt's
  // grants so the response can carry an audit hint without a second
  // query. `pack_audit_state` is the source of truth for audit drift;
  // a missing row means the pack has not yet been audited
  // (`audit_pending`).
  const rows = await deps.rawExec<AuthorityRow>(
    `SELECT a.current_receipt_id,
            r.payload,
            r.signature,
            (
              SELECT pa.status
                FROM receipt_pack_grant g
                LEFT JOIN pack_audit_state pa
                  ON pa.tenant_id = g.tenant_id
                 AND pa.pack_digest = g.pack_digest
               WHERE g.receipt_id = a.current_receipt_id
                 AND g.tenant_id = a.tenant_id
               ORDER BY CASE COALESCE(pa.status, 'audit_pending')
                          WHEN 'quarantined' THEN 0
                          WHEN 'drift' THEN 1
                          WHEN 'audit_pending' THEN 2
                          WHEN 'ok' THEN 3
                          ELSE 4
                        END
               LIMIT 1
            ) AS store_pack_status,
            ras.status AS receipt_audit_status,
            ras.affected_pack_count AS receipt_audit_pack_count
       FROM remote_authority_v2 a
       JOIN receipt r
         ON r.tenant_id = a.tenant_id
        AND r.store_id = a.store_id
        AND r.receipt_id = a.current_receipt_id
       LEFT JOIN receipt_audit_state ras
         ON ras.receipt_id = a.current_receipt_id
        AND ras.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1
        AND a.store_id = $2
      LIMIT 1`,
    [input.tenantId, input.storeId],
  )

  if (rows.length === 0) return { status: 'gone_or_forbidden' }

  const row = rows[0]!
  const payload = coerceJsonbObject(row.payload)
  const signature = coerceJsonbObject(row.signature)
  if (!payload || !signature) {
    // Corrupt row: do not surface a half-receipt to the client. The
    // same `gone_or_forbidden` shape covers it without revealing the
    // corruption to an external caller.
    return { status: 'gone_or_forbidden' }
  }

  const receipt = { payload, signature } as unknown as PromotionReceiptV2
  const auditStatus = mapAuditStatus(row.store_pack_status)
  const repair = buildRepairHint(row, auditStatus)

  const value: CachedAuthority = repair
    ? { receiptId: row.current_receipt_id, receipt, auditStatus, repair }
    : { receiptId: row.current_receipt_id, receipt, auditStatus }
  const entry = deps.cache.set(key, value, now)
  return respondFromCache(value, entry.expiresAt, input.knownReceiptId)
}

function respondFromCache(
  value: CachedAuthority,
  expiresAtMs: number,
  knownReceiptId: string | null,
): AuthorityRefreshResponse {
  const expiresAt = new Date(expiresAtMs).toISOString()
  if (knownReceiptId === value.receiptId) {
    const out: AuthorityRefreshResponse = {
      status: 'unchanged',
      receiptId: value.receiptId,
      expiresAt,
      auditStatus: value.auditStatus,
    }
    if (value.repair) out.repair = value.repair
    return out
  }
  const out: AuthorityRefreshResponse = {
    status: 'updated',
    receipt: value.receipt,
    expiresAt,
    auditStatus: value.auditStatus,
  }
  if (value.repair) out.repair = value.repair
  return out
}

function buildRepairHint(row: AuthorityRow, auditStatus: AuthorityAuditStatus): AuthorityRepairHint | undefined {
  const receiptAuditStatus = (row.receipt_audit_status ?? '').toString()
  if (receiptAuditStatus === 'degraded' || receiptAuditStatus === 'invalidated') {
    const affectedPackCount = Number(row.receipt_audit_pack_count ?? 0) || 0
    const reason: AuthorityRepairHint['reason'] =
      receiptAuditStatus === 'invalidated'
        ? 'invalidated'
        : auditStatus === 'quarantined'
          ? 'missing_pack'
          : 'hash_mismatch'
    return {
      kind: 're_promote_requested',
      reason,
      affectedReceiptId: row.current_receipt_id,
      affectedPackCount,
      message: `Receipt has ${affectedPackCount} affected pack(s). Re-promotion recommended.`,
    }
  }
  return undefined
}

function mapAuditStatus(raw: string | null | undefined): AuthorityAuditStatus {
  switch (raw) {
    case 'quarantined':
      return 'quarantined'
    case 'drift':
      return 'drift'
    case 'ok':
      return 'ok'
    default:
      return 'audit_pending'
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
