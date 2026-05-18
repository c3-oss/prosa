import { z } from 'zod'

import {
  bundleHeadV2Schema,
  canonicalIdSchema,
  missingObjectPlanV2Schema,
  objectSetRootSchema,
  packDigestSchema,
  promotionReceiptV2Schema,
  receiptIdSchema,
  segmentRefSchema,
  transportHashSchema,
} from './primitives.js'

// ----- BeginPromotion --------------------------------------------------------

export const beginPromotionRequestSchema = z.object({
  protocolVersion: z.literal(2),
  tenantId: canonicalIdSchema,
  storeId: canonicalIdSchema,
  storePath: z.string(),
  head: bundleHeadV2Schema,
  inventories: z.object({
    objectInventorySegment: segmentRefSchema,
    projectionInventorySegment: segmentRefSchema,
  }),
  device: z.object({
    deviceId: canonicalIdSchema,
  }),
})

export const beginPromotionResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('already_promoted'),
    receipt: promotionReceiptV2Schema,
  }),
  z.object({
    status: z.literal('needs_inventory'),
    promotionId: canonicalIdSchema,
    missingInventories: z.array(segmentRefSchema),
  }),
  z.object({
    status: z.literal('needs_upload'),
    promotionId: canonicalIdSchema,
    missingSegments: z.array(segmentRefSchema),
    missingObjects: missingObjectPlanV2Schema,
  }),
])

// ----- UploadSegment ---------------------------------------------------------

// Segment uploads carry their metadata in the URL/header layer and stream
// the raw bytes in the body; the wire schema here describes the JSON
// envelope sent alongside (or as a header when the body is bytes).
//
// CQ-012: transport hash distinguishes the bytes ACTUALLY observed on the
// wire from the segment's `digest`. The two will normally agree, but a
// retried upload with chunk re-framing can differ. Servers MUST verify
// `transportHash` against the received bytes and compare it to the
// declared `digest` independently.
export const uploadSegmentRequestSchema = z.object({
  protocolVersion: z.literal(2),
  promotionId: canonicalIdSchema,
  segment: segmentRefSchema,
  transportHash: transportHashSchema,
  // base64-encoded body when transported as JSON; otherwise the bytes are
  // streamed and this field is omitted.
  bodyBase64: z.string().optional(),
})

export const uploadSegmentResponseSchema = z.object({
  status: z.enum(['accepted', 'already_present', 'rejected']),
  segmentId: canonicalIdSchema,
  reason: z.string().optional(),
})

// ----- UploadObjectPack ------------------------------------------------------

// CQ-012: `transportHash` is mandatory on object-pack uploads. It covers
// the bytes received by the server and is checked against `packDigest` to
// catch transport corruption before the pack is admitted into CAS.
export const uploadObjectPackHeaderSchema = z.object({
  protocolVersion: z.literal(2),
  promotionId: canonicalIdSchema,
  packDigest: packDigestSchema,
  transportHash: transportHashSchema,
  byteLength: z.number().int().nonnegative(),
  objectCount: z.number().int().nonnegative(),
  objectSetRoot: objectSetRootSchema,
  standaloneLargeObject: z.boolean(),
})

export const uploadObjectPackResponseSchema = z.object({
  status: z.enum(['accepted', 'already_present', 'rejected']),
  packDigest: packDigestSchema,
  reason: z.string().optional(),
})

// ----- SealPromotion ---------------------------------------------------------

export const sealPromotionRequestSchema = z.object({
  protocolVersion: z.literal(2),
  promotionId: canonicalIdSchema,
})

export const sealPromotionResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('materializing'), promotionId: canonicalIdSchema }),
  z.object({ status: z.literal('sealed'), receipt: promotionReceiptV2Schema }),
  z.object({
    status: z.literal('failed'),
    promotionId: canonicalIdSchema,
    reason: z.string(),
  }),
])

// ----- GetReceipt ------------------------------------------------------------

// CQ-011: GetReceipt request and not_found response use the same canonical
// `receiptIdSchema` as receipt payloads themselves.
export const getReceiptRequestSchema = z.object({
  protocolVersion: z.literal(2),
  receiptId: receiptIdSchema,
})

export const getReceiptResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('found'), receipt: promotionReceiptV2Schema }),
  z.object({ status: z.literal('not_found'), receiptId: receiptIdSchema }),
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
