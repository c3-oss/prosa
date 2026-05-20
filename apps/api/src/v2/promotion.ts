// v2 promotion routes — Lane 4 ships the route definitions only. Each
// returns `501 Not Implemented`. The actual promotion semantics
// (BeginPromotion / UploadSegment / UploadObjectPack / SealPromotion /
// GetReceipt) are Lane 5 surface and intentionally not wired here.
//
// The auth context is resolved on every call so unauthenticated callers
// see `401` and authenticated-but-unmemberd callers see `403`. This
// matches the v1 enforcement order: identity first, then authorization,
// then route logic (which Lane 4 simply refuses).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { type V2AuthDeps, resolveV2AuthContext } from './context.js'

export const V2_PROMOTION_ROUTES = [
  { method: 'POST' as const, url: '/v2/promotions' as const, opName: 'BeginPromotion' as const },
  { method: 'POST' as const, url: '/v2/promotions/:promotionId/segments' as const, opName: 'UploadSegment' as const },
  {
    method: 'POST' as const,
    url: '/v2/promotions/:promotionId/object-packs' as const,
    opName: 'UploadObjectPack' as const,
  },
  { method: 'POST' as const, url: '/v2/promotions/:promotionId/seal' as const, opName: 'SealPromotion' as const },
  { method: 'GET' as const, url: '/v2/receipts/:receiptId' as const, opName: 'GetReceipt' as const },
]

export function registerPromotionRoutes(app: FastifyInstance, deps: V2AuthDeps): void {
  for (const route of V2_PROMOTION_ROUTES) {
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
        reply.code(501)
        return {
          code: 'NOT_IMPLEMENTED',
          op: route.opName,
          message: 'v2 promotion protocol is not implemented in this build (Lane 5 surface).',
        }
      },
    })
  }
}
