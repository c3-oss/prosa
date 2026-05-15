import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ProsaAuth } from '../auth.js'
import type { ProsaApiConfig } from '../config.js'
import type { DatabaseHandle, ProsaDatabase, RawExec } from '../db.js'

export type AuthenticatedUser = {
  id: string
  email: string
  name: string
}

export type MemberRole = 'admin' | 'owner' | 'member'

export type ProsaApiContext = {
  req: FastifyRequest
  res: FastifyReply
  config: ProsaApiConfig
  requestId: string
  auth: ProsaAuth
  db: ProsaDatabase
  rawExec: RawExec
  transaction: DatabaseHandle['transaction']
  objectStore: RemoteObjectStore
  /** Best-effort client IP for local abuse controls and audit metadata. */
  clientIp: string | null
  session: { id: string; userId: string; activeOrganizationId?: string | null; expiresAt?: Date | string } | null
  user: AuthenticatedUser | null
  /**
   * Resolved tenant id. Only set after we have verified that `user` is a
   * member of this tenant. Procedures that require a tenant should rely on
   * this field, never on the raw `x-prosa-tenant-id` header.
   */
  tenantId: string | null
  /** Real membership role for `tenantId`, or null if no membership exists. */
  memberRole: MemberRole | null
  isAdmin: boolean
}

export type CreateContextDeps = {
  config: ProsaApiConfig
  auth: ProsaAuth
  db: ProsaDatabase
  rawExec: RawExec
  transaction: DatabaseHandle['transaction']
  objectStore: RemoteObjectStore
}

function readFirstHeader(req: FastifyRequest, name: string): string | null {
  const value = req.headers[name]
  if (Array.isArray(value)) return value[0] ?? null
  return typeof value === 'string' ? value : null
}

function resolveClientIp(req: FastifyRequest): string | null {
  const forwardedFor = readFirstHeader(req, 'x-forwarded-for')
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim()
    if (first) return first
  }
  const realIp = readFirstHeader(req, 'x-real-ip')
  if (realIp) return realIp
  return req.ip || null
}

function fastifyRequestToHeaders(req: FastifyRequest): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, String(v))
    } else {
      headers.set(key, String(value))
    }
  }
  return headers
}

function normalizeRole(raw: string | null | undefined): MemberRole | null {
  if (!raw) return null
  const lower = raw.toLowerCase()
  if (lower === 'admin' || lower === 'owner' || lower === 'member') return lower
  return null
}

/**
 * Resolve membership for `(tenantId, userId)` via the `member` table. Returns
 * `null` when the user is not a member, which is treated as access denied by
 * `tenantProcedure`. The header-supplied tenant id is treated as a candidate,
 * never as truth — only this lookup grants access.
 */
async function resolveMembership(opts: {
  rawExec: RawExec
  tenantId: string
  userId: string
}): Promise<MemberRole | null> {
  const rows = await opts.rawExec<{ role: string }>(
    'SELECT role FROM "member" WHERE organization_id = $1 AND user_id = $2 ORDER BY created_at ASC, id ASC',
    [opts.tenantId, opts.userId],
  )
  const roles = rows.map((row) => normalizeRole(row.role)).filter((role): role is MemberRole => role !== null)
  if (roles.length === 0) return null
  if (roles.includes('member')) return 'member'
  if (roles.includes('admin')) return 'admin'
  return 'owner'
}

export function buildCreateContext(deps: CreateContextDeps) {
  const { config, auth, db, rawExec, transaction, objectStore } = deps
  return async (opts: { req: FastifyRequest; res: FastifyReply }): Promise<ProsaApiContext> => {
    const headerTenant = readFirstHeader(opts.req, 'x-prosa-tenant-id')
    let session: ProsaApiContext['session'] = null
    let user: ProsaApiContext['user'] = null
    let memberRole: MemberRole | null = null
    let resolvedTenant: string | null = null

    try {
      const result = (await auth.api.getSession({ headers: fastifyRequestToHeaders(opts.req) })) as {
        session: { id: string; userId: string; activeOrganizationId?: string | null; expiresAt?: Date | string }
        user: { id: string; email: string; name: string }
      } | null
      if (result) {
        session = result.session
        user = { id: result.user.id, email: result.user.email, name: result.user.name }
      }
    } catch {
      // unauthenticated requests still produce a context with null session
    }

    if (user) {
      // Tenant resolution precedence:
      //   1. explicit `x-prosa-tenant-id` header
      //   2. active organization on the session
      // In both cases we MUST verify membership before exposing the tenant
      // to procedures.
      const candidate = headerTenant ?? session?.activeOrganizationId ?? null
      if (candidate) {
        const role = await resolveMembership({ rawExec, tenantId: candidate, userId: user.id })
        if (role) {
          resolvedTenant = candidate
          memberRole = role
        }
      }
    }

    return {
      req: opts.req,
      res: opts.res,
      config,
      requestId: opts.req.id,
      auth,
      db,
      rawExec,
      transaction,
      objectStore,
      clientIp: resolveClientIp(opts.req),
      session,
      user,
      tenantId: resolvedTenant,
      memberRole,
      isAdmin: memberRole === 'admin' || memberRole === 'owner',
    }
  }
}

export { resolveMembership }
