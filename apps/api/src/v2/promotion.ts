// v2 promotion routes.
//
// All five Lane 5 routes are implemented:
//
// - `POST /v2/promotions/begin` — fast path + staging row open.
// - `PUT /v2/promotions/:promotionId/segments/:segmentId` —
//   inventory/projection segment upload with BLAKE3 verification.
// - `POST /v2/promotions/:promotionId/object-packs` — CAS pack upload
//   with `verifyCasPack` + `remote_pack` catalog INSERT.
// - `POST /v2/promotions/:promotionId/seal` — load-bearing
//   authority-swap transaction.
// - `GET /v2/receipts/:receiptId` — tenant-scoped receipt lookup
//   for clients that lost the seal response.
//
// The auth context is resolved on every call so unauthenticated callers
// see `401` and authenticated-but-unmemberd callers see `403`. This
// matches the v1 enforcement order: identity first, then authorization,
// then route logic.

import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { DatabaseHandle } from '../db.js'
import { type V2AuthDeps, resolveV2AuthContext } from './context.js'
import type { ReceiptSigner } from './signing/local-signer.js'
import {
  BeginPromotionAuthorityCorruptError,
  BeginPromotionDeviceOwnershipError,
  BeginPromotionTenantMismatchError,
  BeginPromotionValidationError,
  beginPromotion,
} from './sync/begin-promotion.js'
import { GetPromotionStatusNotFoundError, getPromotionStatus } from './sync/get-promotion-status.js'
import { getReceipt } from './sync/get-receipt.js'
import {
  SealPromotionCoverageError,
  SealPromotionInProgressError,
  SealPromotionInventoryIncompleteError,
  SealPromotionNotFoundError,
  sealPromotion,
} from './sync/seal-promotion.js'
import {
  UploadObjectPackNotFoundError,
  UploadObjectPackValidationError,
  uploadObjectPack,
} from './sync/upload-object-pack.js'
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
  {
    method: 'GET' as const,
    url: '/v2/promotions/:promotionId/status' as const,
    opName: 'GetPromotionStatus' as const,
  },
]

export type PromotionRoutesDeps = V2AuthDeps & {
  objectStore: RemoteObjectStore
  transaction: DatabaseHandle['transaction']
  signer: ReceiptSigner
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
        if (route.opName === 'UploadObjectPack') {
          return handleUploadObjectPack(deps, ctx.tenantId, req, reply)
        }
        if (route.opName === 'SealPromotion') {
          return handleSealPromotion(deps, ctx.tenantId, req, reply)
        }
        if (route.opName === 'GetReceipt') {
          return handleGetReceipt(deps, ctx.tenantId, req, reply)
        }
        if (route.opName === 'GetPromotionStatus') {
          return handleGetPromotionStatus(deps, ctx.tenantId, req, reply)
        }
        // All Lane 5 routes are wired; this branch is unreachable
        // once the literal union above is exhaustively matched.
        // Keep it as a defense-in-depth fallthrough.
        reply.code(501)
        return {
          code: 'NOT_IMPLEMENTED',
          op: (route as { opName: string }).opName,
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
    if (err instanceof BeginPromotionAuthorityCorruptError) {
      // CQ-125: corrupt authority state surfaces as 500. The route
      // intentionally avoids 200/409 here — a client should not
      // retry around this; an operator must heal the orphan.
      reply.code(500)
      return { code: err.code, op: 'BeginPromotion', message: err.message }
    }
    if (err instanceof BeginPromotionDeviceOwnershipError) {
      // CQ-127: a device-steal attempt is a 403. The client
      // should pick a different device id or have the original
      // owner release it.
      reply.code(403)
      return { code: err.code, op: 'BeginPromotion', message: err.message }
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

async function handleUploadObjectPack(
  deps: PromotionRoutesDeps,
  tenantId: string,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const params = req.params as { promotionId?: string }
  if (!params.promotionId) {
    reply.code(400)
    return { code: 'INVALID_REQUEST', op: 'UploadObjectPack', message: 'promotionId is required' }
  }
  const body = toUint8Array(req.body)
  if (!body) {
    reply.code(400)
    return {
      code: 'INVALID_REQUEST',
      op: 'UploadObjectPack',
      message: 'octet-stream body required (Content-Type: application/octet-stream)',
    }
  }
  const declaredPackDigest = readSingleHeader(req, 'x-prosa-pack-digest')
  const transportHash = readSingleHeader(req, 'x-prosa-transport-hash')
  try {
    const result = await uploadObjectPack(
      {
        rawExec: deps.rawExec,
        transaction: deps.transaction,
        tenantId,
        objectStore: deps.objectStore,
      },
      { promotionId: params.promotionId, body, declaredPackDigest, transportHash },
    )
    reply.code(200)
    return result
  } catch (err) {
    if (err instanceof UploadObjectPackNotFoundError) {
      reply.code(404)
      return { code: err.code, op: 'UploadObjectPack', message: err.message }
    }
    if (err instanceof UploadObjectPackValidationError) {
      reply.code(400)
      return { code: 'INVALID_REQUEST', op: 'UploadObjectPack', message: err.message, issues: err.issues }
    }
    throw err
  }
}

async function handleSealPromotion(
  deps: PromotionRoutesDeps,
  tenantId: string,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const params = req.params as { promotionId?: string }
  if (!params.promotionId) {
    reply.code(400)
    return { code: 'INVALID_REQUEST', op: 'SealPromotion', message: 'promotionId is required' }
  }
  try {
    const result = await sealPromotion(
      {
        rawExec: deps.rawExec,
        transaction: deps.transaction,
        tenantId,
        objectStore: deps.objectStore,
        signer: deps.signer,
      },
      { promotionId: params.promotionId },
    )
    reply.code(200)
    return result
  } catch (err) {
    if (err instanceof SealPromotionNotFoundError) {
      reply.code(404)
      return { code: err.code, op: 'SealPromotion', message: err.message }
    }
    if (err instanceof SealPromotionInProgressError) {
      reply.code(409)
      return { code: err.code, op: 'SealPromotion', message: err.message }
    }
    if (err instanceof SealPromotionInventoryIncompleteError) {
      reply.code(409)
      return {
        code: err.code,
        op: 'SealPromotion',
        message: err.message,
        missingSegmentIds: err.missingSegmentIds,
      }
    }
    if (err instanceof SealPromotionCoverageError) {
      reply.code(409)
      return {
        code: err.code,
        op: 'SealPromotion',
        message: err.message,
        declaredObjectCount: err.declaredObjectCount,
        catalogObjectCount: err.catalogObjectCount,
      }
    }
    throw err
  }
}

async function handleGetPromotionStatus(
  deps: PromotionRoutesDeps,
  tenantId: string,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const params = req.params as { promotionId?: string }
  if (!params.promotionId) {
    reply.code(400)
    return { code: 'INVALID_REQUEST', op: 'GetPromotionStatus', message: 'promotionId is required' }
  }
  try {
    const result = await getPromotionStatus(
      { rawExec: deps.rawExec, tenantId, objectStore: deps.objectStore },
      { promotionId: params.promotionId },
    )
    reply.code(200)
    return result
  } catch (err) {
    if (err instanceof GetPromotionStatusNotFoundError) {
      reply.code(404)
      return { code: err.code, op: 'GetPromotionStatus', message: err.message }
    }
    throw err
  }
}

async function handleGetReceipt(
  deps: PromotionRoutesDeps,
  tenantId: string,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const params = req.params as { receiptId?: string }
  if (!params.receiptId) {
    reply.code(400)
    return { code: 'INVALID_REQUEST', op: 'GetReceipt', message: 'receiptId is required' }
  }
  const result = await getReceipt(
    { rawExec: deps.rawExec, tenantId, signer: deps.signer },
    { receiptId: params.receiptId },
  )
  if (result.status === 'not_found') {
    reply.code(404)
    return { code: 'RECEIPT_NOT_FOUND', op: 'GetReceipt', status: 'not_found', receiptId: result.receiptId }
  }
  reply.code(200)
  return result
}

function readSingleHeader(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name]
  if (Array.isArray(value)) return value[0]
  return value
}

function toUint8Array(body: unknown): Uint8Array | null {
  if (body == null) return null
  if (body instanceof Uint8Array) return body
  if (Buffer.isBuffer(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  return null
}
