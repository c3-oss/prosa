// Lane 9 — `POST /v2/migrate/tenant`.
//
// Admin-tenant route that drives `migrateTenant`. The auth ladder
// mirrors the v2 promotion surface: 401 on unauthenticated calls,
// 403 when the caller is authenticated but lacks an active tenant
// or is not `admin`/`owner` for it. Member-role users (read-only
// access) see 403 with code `INSUFFICIENT_ROLE`.
//
// The handler validates the body shape, then forwards to
// `migrateTenant` which owns transactional state.

import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import type { DatabaseHandle } from '../../db.js'
import { type V2AuthDeps, resolveV2AuthContext } from '../context.js'
import type { ReceiptSigner } from '../signing/local-signer.js'
import { migrateTenant } from './tenant.js'

export const V2_MIGRATE_ROUTES = [
  {
    method: 'POST' as const,
    url: '/v2/migrate/tenant' as const,
    opName: 'MigrateTenant' as const,
  },
]

export type MigrateRoutesDeps = V2AuthDeps & {
  objectStore: RemoteObjectStore
  transaction: DatabaseHandle['transaction']
  signer: ReceiptSigner
  serverRegion?: string
}

export function registerMigrateRoutes(app: FastifyInstance, deps: MigrateRoutesDeps): void {
  for (const route of V2_MIGRATE_ROUTES) {
    app.route({
      method: route.method,
      url: route.url,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = await resolveV2AuthContext(deps, req)
        if (!ctx.user) {
          reply.code(401)
          return { code: 'UNAUTHENTICATED', op: route.opName }
        }
        if (!ctx.tenantId) {
          reply.code(403)
          return { code: 'TENANT_REQUIRED', op: route.opName }
        }
        // CQ-127: only `admin`/`owner` may trigger migration.
        if (ctx.memberRole !== 'admin' && ctx.memberRole !== 'owner') {
          reply.code(403)
          return {
            code: 'INSUFFICIENT_ROLE',
            op: route.opName,
            message: 'migrate-tenant requires admin/owner role on the active tenant',
          }
        }
        const body = (req.body ?? {}) as { tenantId?: string; storeId?: string; serverRegion?: string }
        if (!body.tenantId) {
          reply.code(400)
          return { code: 'INVALID_REQUEST', op: route.opName, message: 'tenantId is required' }
        }
        if (body.tenantId !== ctx.tenantId) {
          reply.code(403)
          return { code: 'TENANT_MISMATCH', op: route.opName, message: 'tenantId must match the authenticated tenant' }
        }
        try {
          const result = await migrateTenant(
            {
              rawExec: deps.rawExec,
              transaction: deps.transaction,
              objectStore: deps.objectStore,
              signer: deps.signer,
              serverRegion: deps.serverRegion,
            },
            { tenantId: body.tenantId, storeId: body.storeId, serverRegion: body.serverRegion },
          )
          reply.code(200)
          return result
        } catch (err) {
          reply.code(500)
          return {
            code: 'MIGRATION_FAILED',
            op: route.opName,
            message: err instanceof Error ? err.message : String(err),
          }
        }
      },
    })
  }
}

export type { MigrateTenantInput, MigrateTenantResponse, LegacyV1SourceFile, MigrateTenantGap } from './tenant.js'
