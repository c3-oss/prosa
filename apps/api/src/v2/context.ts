// Auth context resolver for /v2/* routes. Preserves the v1 Better Auth
// behavior end-to-end: the session, user, and tenant are resolved through
// the same `auth.api.getSession` call and the same `member` table lookup
// as the tRPC context. Headers, cookies, and Origin handling come from
// the request unchanged. Tenant resolution mirrors `objects.ts`'s
// `resolveAuth`: header takes precedence, then session
// `activeOrganizationId`, and either way the lookup must hit the member
// table before the tenant is exposed.

import type { FastifyRequest } from 'fastify'
import type { ProsaAuth } from '../auth.js'
import type { RawExec } from '../db.js'
import { readFirstHeader, requestToHeaders } from '../shared/http.js'
import { type MemberRole, resolveMembership } from '../trpc/context.js'

export type V2User = { id: string; email: string; name: string }
export type V2Session = {
  id: string
  userId: string
  activeOrganizationId?: string | null
  expiresAt?: Date | string
}

export type V2AuthContext = {
  user: V2User | null
  session: V2Session | null
  tenantId: string | null
  memberRole: MemberRole | null
}

export type V2AuthDeps = {
  auth: ProsaAuth
  rawExec: RawExec
}

export async function resolveV2AuthContext(deps: V2AuthDeps, req: FastifyRequest): Promise<V2AuthContext> {
  let user: V2User | null = null
  let session: V2Session | null = null
  try {
    const result = (await deps.auth.api.getSession({ headers: requestToHeaders(req) })) as {
      session: V2Session
      user: { id: string; email: string; name: string }
    } | null
    if (result) {
      session = result.session
      user = { id: result.user.id, email: result.user.email, name: result.user.name }
    }
  } catch {
    // Unauthenticated requests still produce a context with null fields;
    // route guards (`requireV2User`/`requireV2Tenant`) decide the
    // response code.
  }

  if (!user) return { user: null, session: null, tenantId: null, memberRole: null }

  const candidate = readFirstHeader(req, 'x-prosa-tenant-id') ?? session?.activeOrganizationId ?? null
  if (!candidate) return { user, session, tenantId: null, memberRole: null }

  const role = await resolveMembership({ rawExec: deps.rawExec, tenantId: candidate, userId: user.id })
  if (!role) return { user, session, tenantId: null, memberRole: null }
  return { user, session, tenantId: candidate, memberRole: role }
}
