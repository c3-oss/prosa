// v2 promotion routes.
//
// Lane 4 shipped these as 501 placeholders. Lane 5 fills the protocol
// handler by handler:
//
// - `POST /v2/promotions/begin` — implemented (fast path + staging row).
// - `PUT /v2/promotions/:promotionId/segments/:segmentId` — implemented
//   (slice 3: inventory + projection segment upload, BLAKE3-verified).
// - `POST /v2/promotions/:promotionId/object-packs` — 501.
// - `POST /v2/promotions/:promotionId/seal` — 501.
// - `GET /v2/receipts/:receiptId` — 501.
//
// The auth context is resolved on every call so unauthenticated callers
// see `401` and authenticated-but-unmemberd callers see `403`. This
// matches the v1 enforcement order: identity first, then authorization,
// then route logic.

import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { type V2AuthDeps, resolveV2AuthContext } from './context.js'
import {
  BeginPromotionTenantMismatchError,
  BeginPromotionValidationError,
  beginPromotion,
} from './sync/begin-promotion.js'
import { UploadSegmentNotFoundError, UploadSegmentValidationError, uploadSegment } from './sync/upload-segment.js'

export const V2_PROMOTION_ROUTES = [
  { method: 'POST' as const, url: '/v2/promotions/begin' as const, opName: 'BeginPromotion' as const },
  {
    method: 'PUT' as const,
    url: '/v2/promotions/:promotionId/segments/:segmentId' as const,
    opName: 'UploadSegment' as const,
  },
  {
    method: 'POST' as const,
    url: '/v2/promotions/:promotionId/object-packs' as const,
    opName: 'UploadObjectPack' as const,
  },
  { method: 'POST' as const, url: '/v2/promotions/:promotionId/seal' as const, opName: 'SealPromotion' as const },
  { method: 'GET' as const, url: '/v2/receipts/:receiptId' as const, opName: 'GetReceipt' as const },
]

export type PromotionRoutesDeps = V2AuthDeps & {
  objectStore: RemoteObjectStore
}

export function registerPromotionRoutes(app: FastifyInstance, deps: PromotionRoutesDeps): void {
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
        if (route.opName === 'BeginPromotion') {
          return handleBeginPromotion(deps, ctx.tenantId, ctx.user.id, req, reply)
        }
        if (route.opName === 'UploadSegment') {
          return handleUploadSegment(deps, ctx.tenantId, req, reply)
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

async function handleBeginPromotion(
  deps: PromotionRoutesDeps,
  tenantId: string,
  userId: string,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  try {
    const response = await beginPromotion({ rawExec: deps.rawExec, tenantId, userId }, req.body)
    reply.code(200)
    return response
  } catch (err) {
    if (err instanceof BeginPromotionValidationError) {
      reply.code(400)
      return { code: 'INVALID_REQUEST', op: 'BeginPromotion', issues: err.issues }
    }
    if (err instanceof BeginPromotionTenantMismatchError) {
      reply.code(403)
      return { code: 'TENANT_MISMATCH', op: 'BeginPromotion', message: err.message }
    }
    throw err
  }
}

async function handleUploadSegment(
  deps: PromotionRoutesDeps,
  tenantId: string,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const params = req.params as { promotionId?: string; segmentId?: string }
  if (!params.promotionId || !params.segmentId) {
    reply.code(400)
    return { code: 'INVALID_REQUEST', op: 'UploadSegment', message: 'promotionId and segmentId are required' }
  }
  const body = toUint8Array(req.body)
  if (!body) {
    reply.code(400)
    return {
      code: 'INVALID_REQUEST',
      op: 'UploadSegment',
      message: 'octet-stream body required (Content-Type: application/octet-stream)',
    }
  }
  const rawTransport = req.headers['x-prosa-transport-hash']
  const transportHash = Array.isArray(rawTransport) ? rawTransport[0] : rawTransport
  try {
    const result = await uploadSegment(
      { rawExec: deps.rawExec, tenantId, objectStore: deps.objectStore },
      {
        promotionId: params.promotionId,
        segmentId: params.segmentId,
        body,
        transportHash,
      },
    )
    reply.code(200)
    return result
  } catch (err) {
    if (err instanceof UploadSegmentNotFoundError) {
      reply.code(404)
      return { code: err.code, op: 'UploadSegment', message: err.message }
    }
    if (err instanceof UploadSegmentValidationError) {
      reply.code(400)
      return { code: 'INVALID_REQUEST', op: 'UploadSegment', message: err.message, issues: err.issues }
    }
    throw err
  }
}

function toUint8Array(body: unknown): Uint8Array | null {
  if (body == null) return null
  if (body instanceof Uint8Array) return body
  if (Buffer.isBuffer(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  return null
}
