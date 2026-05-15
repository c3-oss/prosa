import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ProsaApiConfig } from '../config.js'

export type ProsaApiContext = {
  req: FastifyRequest
  res: FastifyReply
  config: ProsaApiConfig
  requestId: string
  session: null
  user: null
  tenantId: string | null
  memberRole: 'admin' | 'member' | null
  isAdmin: boolean
}

export type CreateContextDeps = {
  config: ProsaApiConfig
}

export function buildCreateContext(deps: CreateContextDeps) {
  const { config } = deps
  return (opts: { req: FastifyRequest; res: FastifyReply }): ProsaApiContext => {
    const headerTenant = (opts.req.headers['x-prosa-tenant-id'] ?? null) as string | null
    return {
      req: opts.req,
      res: opts.res,
      config,
      requestId: opts.req.id,
      session: null,
      user: null,
      tenantId: headerTenant,
      memberRole: null,
      isAdmin: false,
    }
  }
}
