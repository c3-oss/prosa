// Lane 7 — authority resolver.
//
// `resolveAuthority` implements the L12 refresh policy:
//   - `--offline`: use the cached record or fail closed.
//   - within the 60 s TTL: skip the network and return the cached record.
//   - outside the TTL or `--refresh`: issue `GET /v2/stores/:storeId/authority`,
//     persist the result, and return it.
//
// On a 412 (`PRECONDITION_FAILED` / receipt no longer current), the
// caller-side helper `handle412` calls `refreshAuthorityNow` once and
// hands the refreshed record back. Mid-streaming-output callers receive
// `AuthorityChangedError` so they can stop with an explicit message
// rather than continue against stale data.

import type { PromotionReceiptV2 } from '@c3-oss/prosa-types-v2'
import { AUTHORITY_TTL_MS, getCachedAuthority, isFresh, writeCachedAuthority } from './cache.js'
import type { CachedAuthorityV2, CachedAuthorityV2AuditStatus } from './types.js'

export class AuthorityResolveError extends Error {
  override name = 'AuthorityResolveError'
}

export class AuthorityChangedError extends Error {
  override name = 'AuthorityChangedError'
  constructor(message = 'Authority changed mid-command; rerun the command to use the new receipt.') {
    super(message)
  }
}

/**
 * Wire shape returned by `GET /v2/stores/:storeId/authority`.
 *
 * Mirrors `AuthorityRefreshResponse` on the server. Kept inline so
 * the CLI does not pull in the @c3-oss/prosa-api package.
 */
export type AuthorityRefreshWire =
  | {
      status: 'unchanged'
      receiptId: string
      expiresAt: string
      auditStatus: CachedAuthorityV2AuditStatus
    }
  | {
      status: 'updated'
      receipt: PromotionReceiptV2
      expiresAt: string
      auditStatus: CachedAuthorityV2AuditStatus
    }
  | { status: 'gone_or_forbidden' }

export type ResolveAuthorityOptions = {
  configDir: string
  serverUrl: string
  tenantId: string
  storeId: string
  /** Bearer token for `Authorization`. */
  token: string
  /** Force a network refresh even when the cache is fresh. */
  forceRefresh?: boolean
  /** Use the cached record only; never hit the network. */
  offline?: boolean
  /** Inject for tests; defaults to `Date.now`. */
  now?: () => number
  /** Inject for tests; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
}

export async function resolveAuthority(opts: ResolveAuthorityOptions): Promise<CachedAuthorityV2> {
  const now = opts.now ?? Date.now
  const cached = await getCachedAuthority(opts.configDir, opts.storeId)

  if (opts.offline) {
    if (!cached) {
      throw new AuthorityResolveError(
        '--offline but no cached authority for this store; run without --offline first to populate the cache.',
      )
    }
    return cached
  }

  if (cached && !opts.forceRefresh && isFresh(cached, now())) {
    return cached
  }

  return refreshAuthorityNow({ ...opts, knownReceiptId: cached?.receiptId, now })
}

export type RefreshAuthorityNowOptions = ResolveAuthorityOptions & {
  knownReceiptId?: string
}

export async function refreshAuthorityNow(opts: RefreshAuthorityNowOptions): Promise<CachedAuthorityV2> {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const now = opts.now ?? Date.now
  const url = new URL(`/v2/stores/${encodeURIComponent(opts.storeId)}/authority`, opts.serverUrl)
  if (opts.knownReceiptId) url.searchParams.set('knownReceiptId', opts.knownReceiptId)

  const response = await fetchFn(url.toString(), {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${opts.token}`,
      'x-prosa-tenant-id': opts.tenantId,
    },
  })

  if (response.status === 401)
    throw new AuthorityResolveError('authority refresh unauthorized (401); run `prosa auth login`.')
  if (response.status === 403)
    throw new AuthorityResolveError('authority refresh forbidden (403); check tenant membership.')
  if (response.status === 404)
    throw new AuthorityResolveError(`authority refresh failed: store ${opts.storeId} not found (404).`)
  if (response.status >= 500) {
    const text = await safeText(response)
    throw new AuthorityResolveError(`authority refresh failed: HTTP ${response.status} ${text}`)
  }

  const body = (await response.json()) as AuthorityRefreshWire

  if (body.status === 'gone_or_forbidden') {
    throw new AuthorityResolveError('store has no current authority for this tenant (gone or forbidden).')
  }

  const checkedAtMs = now()
  const checkedAt = new Date(checkedAtMs).toISOString()
  const expiresAt = new Date(checkedAtMs + AUTHORITY_TTL_MS).toISOString()

  let next: CachedAuthorityV2
  if (body.status === 'unchanged') {
    const cached = await getCachedAuthority(opts.configDir, opts.storeId)
    if (!cached) {
      throw new AuthorityResolveError(
        'authority refresh returned `unchanged` but the CLI has no cached receipt; rerun with --refresh to fetch the receipt.',
      )
    }
    next = {
      ...cached,
      checkedAt,
      expiresAt: body.expiresAt ?? expiresAt,
      auditStatus: body.auditStatus,
    }
  } else {
    next = {
      tenantId: opts.tenantId,
      storeId: opts.storeId,
      receiptId: body.receipt.payload.receiptId,
      receipt: body.receipt,
      serverUrl: opts.serverUrl,
      checkedAt,
      expiresAt: body.expiresAt ?? expiresAt,
      auditStatus: body.auditStatus,
    }
  }

  await writeCachedAuthority(opts.configDir, next)
  return next
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 240)
  } catch {
    return ''
  }
}
