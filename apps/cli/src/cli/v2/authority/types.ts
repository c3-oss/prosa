// Lane 7 — v2 CLI authority cache types.
//
// `CachedAuthorityV2` is the on-disk record produced by the v2 authority
// resolver. It pins the receipt that the next read call must surface,
// the TTL boundary at which the resolver will hit the network again,
// and the audit-status hint the server returned so the CLI can warn the
// operator about a degraded / quarantined store without an extra
// round-trip.

import type { PromotionReceiptV2 } from '@c3-oss/prosa-types-v2'

/** Audit-status hint surfaced by `GET /v2/stores/:storeId/authority`. */
export type CachedAuthorityV2AuditStatus = 'ok' | 'audit_pending' | 'drift' | 'quarantined'

export type CachedAuthorityV2 = {
  tenantId: string
  storeId: string
  receiptId: string
  /** Cached promotion receipt for offline verification. */
  receipt: PromotionReceiptV2
  /** Server base URL the receipt was fetched from. */
  serverUrl: string
  /** ISO timestamp of the last refresh. */
  checkedAt: string
  /** ISO timestamp at which the cache expires (checkedAt + TTL). */
  expiresAt: string
  auditStatus: CachedAuthorityV2AuditStatus
  /**
   * Optional repair hint surfaced by Lane 8 audit/GC when the
   * receipt's underlying packs are quarantined.
   */
  repair?: { kind: string; reason?: string; message?: string }
}
