import { z } from 'zod'

import {
  bundleHeadV2Schema,
  missingObjectPlanV2Schema,
  promotionReceiptV2Schema,
  segmentRefSchema,
  taggedHashSchema,
} from './primitives.js'

// ----- BeginPromotion --------------------------------------------------------

export const beginPromotionRequestSchema = z.object({
  protocolVersion: z.literal(2),
  tenantId: z.string().min(1),
  storeId: z.string().min(1),
  storePath: z.string(),
  head: bundleHeadV2Schema,
  inventories: z.object({
    objectInventorySegment: segmentRefSchema,
    projectionInventorySegment: segmentRefSchema,
  }),
  device: z.object({
    deviceId: z.string().min(1),
  }),
})

export const beginPromotionResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('already_promoted'),
    receipt: promotionReceiptV2Schema,
  }),
  z.object({
    status: z.literal('needs_inventory'),
    promotionId: z.string().min(1),
    missingInventories: z.array(segmentRefSchema),
  }),
  z.object({
    status: z.literal('needs_upload'),
    promotionId: z.string().min(1),
    missingSegments: z.array(segmentRefSchema),
    missingObjects: missingObjectPlanV2Schema,
  }),
])

// ----- UploadSegment ---------------------------------------------------------

// Segment uploads carry their metadata in the URL/header layer and stream
// the raw bytes in the body; the wire schema here describes the JSON
// envelope sent alongside (or as a header when the body is bytes).
export const uploadSegmentRequestSchema = z.object({
  protocolVersion: z.literal(2),
  promotionId: z.string().min(1),
  segment: segmentRefSchema,
  // base64-encoded body when transported as JSON; otherwise the bytes are
  // streamed and this field is omitted.
  bodyBase64: z.string().optional(),
})

export const uploadSegmentResponseSchema = z.object({
  status: z.enum(['accepted', 'already_present', 'rejected']),
  segmentId: z.string().min(1),
  reason: z.string().optional(),
})

// ----- UploadObjectPack ------------------------------------------------------

export const uploadObjectPackHeaderSchema = z.object({
  protocolVersion: z.literal(2),
  promotionId: z.string().min(1),
  packDigest: taggedHashSchema,
  byteLength: z.number().int().nonnegative(),
  objectCount: z.number().int().nonnegative(),
  objectSetRoot: z.string().regex(/^[0-9a-f]{64}$/u),
  standaloneLargeObject: z.boolean(),
})

export const uploadObjectPackResponseSchema = z.object({
  status: z.enum(['accepted', 'already_present', 'rejected']),
  packDigest: taggedHashSchema,
  reason: z.string().optional(),
})

// ----- SealPromotion ---------------------------------------------------------

export const sealPromotionRequestSchema = z.object({
  protocolVersion: z.literal(2),
  promotionId: z.string().min(1),
})

export const sealPromotionResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('materializing'), promotionId: z.string().min(1) }),
  z.object({ status: z.literal('sealed'), receipt: promotionReceiptV2Schema }),
  z.object({
    status: z.literal('failed'),
    promotionId: z.string().min(1),
    reason: z.string(),
  }),
])

// ----- GetReceipt ------------------------------------------------------------

export const getReceiptRequestSchema = z.object({
  protocolVersion: z.literal(2),
  receiptId: z.string().regex(/^rcpt_[A-Za-z0-9_-]+$/u),
})

export const getReceiptResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('found'), receipt: promotionReceiptV2Schema }),
  z.object({ status: z.literal('not_found'), receiptId: z.string() }),
])

// ----- Inferred types --------------------------------------------------------

export type BeginPromotionRequest = z.infer<typeof beginPromotionRequestSchema>
export type BeginPromotionResponse = z.infer<typeof beginPromotionResponseSchema>
export type UploadSegmentRequest = z.infer<typeof uploadSegmentRequestSchema>
export type UploadSegmentResponse = z.infer<typeof uploadSegmentResponseSchema>
export type UploadObjectPackHeader = z.infer<typeof uploadObjectPackHeaderSchema>
export type UploadObjectPackResponse = z.infer<typeof uploadObjectPackResponseSchema>
export type SealPromotionRequest = z.infer<typeof sealPromotionRequestSchema>
export type SealPromotionResponse = z.infer<typeof sealPromotionResponseSchema>
export type GetReceiptRequest = z.infer<typeof getReceiptRequestSchema>
export type GetReceiptResponse = z.infer<typeof getReceiptResponseSchema>
