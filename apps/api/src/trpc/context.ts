import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ProsaAuth } from '../auth.js'
import type { ProsaApiConfig } from '../config.js'

export type AuthenticatedUser = {
  id: string
  email: string
  name: string
}

export type ProsaApiContext = {
  req: FastifyRequest
  res: FastifyReply
  config: ProsaApiConfig
  requestId: string
  auth: ProsaAuth
  session: { id: string; userId: string; activeOrganizationId?: string | null } | null
  user: AuthenticatedUser | null
  tenantId: string | null
  memberRole: 'admin' | 'member' | 'owner' | null
  isAdmin: boolean
}

export type CreateContextDeps = {
  config: ProsaApiConfig
  auth: ProsaAuth
}

function readFirstHeader(req: FastifyRequest, name: string): string | null {
  const value = req.headers[name]
  if (Array.isArray(value)) return value[0] ?? null
  return typeof value === 'string' ? value : null
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

export function buildCreateContext(deps: CreateContextDeps) {
  const { config, auth } = deps
  return async (opts: { req: FastifyRequest; res: FastifyReply }): Promise<ProsaApiContext> => {
    const headerTenant = readFirstHeader(opts.req, 'x-prosa-tenant-id')
    let session: ProsaApiContext['session'] = null
    let user: ProsaApiContext['user'] = null
    const memberRole: ProsaApiContext['memberRole'] = null
    let tenantId: string | null = headerTenant

    try {
      const result = (await auth.api.getSession({ headers: fastifyRequestToHeaders(opts.req) })) as {
        session: { id: string; userId: string; activeOrganizationId?: string | null }
        user: { id: string; email: string; name: string }
      } | null
      if (result) {
        session = result.session
        user = { id: result.user.id, email: result.user.email, name: result.user.name }
        if (!tenantId && session.activeOrganizationId) tenantId = session.activeOrganizationId
      }
    } catch {
      // unauthenticated requests still produce a context with null session
    }

    return {
      req: opts.req,
      res: opts.res,
      config,
      requestId: opts.req.id,
      auth,
      session,
      user,
      tenantId,
      memberRole,
      isAdmin: memberRole === 'admin' || memberRole === 'owner',
    }
  }
}
