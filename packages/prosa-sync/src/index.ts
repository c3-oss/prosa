import { z } from 'zod'

export const PROTOCOL_VERSION = 1

// ---------- Object manifests ----------

export const objectManifestEntrySchema = z.object({
  objectId: z.string().min(1),
  hash: z.string().min(8),
  hashAlgorithm: z.enum(['blake3', 'sha256']).default('blake3'),
  uncompressedSize: z.number().int().nonnegative(),
  compressedSize: z.number().int().nonnegative(),
  contentType: z.string().optional(),
})
export type ObjectManifestEntry = z.infer<typeof objectManifestEntrySchema>

// ---------- Projection rows ----------

export const sourceFileRowSchema = z.object({
  id: z.string().min(1),
  sourceKind: z.string().min(1),
  path: z.string().min(1),
  objectId: z.string().min(1).nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
})
export type SourceFileRow = z.infer<typeof sourceFileRowSchema>

export const rawRecordRowSchema = z.object({
  id: z.string().min(1),
  sourceFileId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  payload: z.unknown(),
  objectId: z.string().min(1).nullable().optional(),
})
export type RawRecordRow = z.infer<typeof rawRecordRowSchema>

export const projectionSessionRowSchema = z.object({
  id: z.string().min(1),
  sourceKind: z.string().min(1),
  projectId: z.string().min(1).nullable().optional(),
  title: z.string().nullable().optional(),
  startedAt: z.string().datetime().nullable().optional(),
  endedAt: z.string().datetime().nullable().optional(),
  turnCount: z.number().int().nonnegative().default(0),
  metadata: z.record(z.unknown()).nullable().optional(),
})
export type ProjectionSessionRow = z.infer<typeof projectionSessionRowSchema>

export const searchDocRowSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  kind: z.string().min(1),
  body: z.string(),
})
export type SearchDocRow = z.infer<typeof searchDocRowSchema>

export const projectionPayloadSchema = z.object({
  sourceFiles: z.array(sourceFileRowSchema).default([]),
  rawRecords: z.array(rawRecordRowSchema).default([]),
  sessions: z.array(projectionSessionRowSchema).default([]),
  searchDocs: z.array(searchDocRowSchema).default([]),
})
export type ProjectionPayload = z.infer<typeof projectionPayloadSchema>

// ---------- Handshake ----------

export const handshakeInputSchema = z.object({
  cliVersion: z.string().min(1),
  protocolVersion: z.number().int().min(1).default(PROTOCOL_VERSION),
  device: z.object({
    name: z.string().min(1),
    platform: z.string().optional(),
  }),
  store: z.object({
    path: z.string().min(1),
    bundleVersion: z.string().min(1),
  }),
})
export type HandshakeInput = z.infer<typeof handshakeInputSchema>

export const handshakeOutputSchema = z.object({
  serverVersion: z.string(),
  protocolVersion: z.number().int(),
  deviceId: z.string().min(1),
  promoted: z.boolean(),
  limits: z.object({
    maxObjectsPerPlan: z.number().int().positive(),
    maxRowsPerCommit: z.number().int().positive(),
    maxObjectBytes: z.number().int().positive(),
  }),
})
export type HandshakeOutput = z.infer<typeof handshakeOutputSchema>

// ---------- planUpload ----------

export const planUploadInputSchema = z.object({
  deviceId: z.string().min(1),
  storePath: z.string().min(1),
  objects: z.array(objectManifestEntrySchema).default([]),
})
export type PlanUploadInput = z.infer<typeof planUploadInputSchema>

export const planUploadOutputSchema = z.object({
  batchId: z.string().min(1),
  missingObjectIds: z.array(z.string()),
  uploadUrlTemplate: z.string(),
})
export type PlanUploadOutput = z.infer<typeof planUploadOutputSchema>

// ---------- commitUpload ----------

export const commitUploadInputSchema = z.object({
  batchId: z.string().min(1),
  deviceId: z.string().min(1),
  storePath: z.string().min(1),
  objects: z.array(objectManifestEntrySchema).default([]),
  projection: projectionPayloadSchema.default({}),
})
export type CommitUploadInput = z.infer<typeof commitUploadInputSchema>

export const commitUploadOutputSchema = z.object({
  batchId: z.string(),
  committedObjects: z.number().int().nonnegative(),
  committedRows: z.number().int().nonnegative(),
})
export type CommitUploadOutput = z.infer<typeof commitUploadOutputSchema>

// ---------- verifyPromotion ----------

export const verifyPromotionInputSchema = z.object({
  batchId: z.string().min(1),
  storePath: z.string().min(1),
  sampleSessionIds: z.array(z.string()).max(20).default([]),
  /**
   * Object IDs the client uploaded in this batch. Every entry must have a
   * matching `tenant_object` provenance row for the caller's tenant before
   * `verifyPromotion` will emit a receipt. Used to authorize destructive
   * cleanup.
   */
  declaredObjectIds: z.array(z.string()).max(10_000).default([]),
  /** Session ids the client claims were uploaded; verifier confirms each. */
  declaredSessionIds: z.array(z.string()).max(10_000).default([]),
  /** Search doc ids the client claims were uploaded; verifier confirms each. */
  declaredSearchDocIds: z.array(z.string()).max(10_000).default([]),
})
export type VerifyPromotionInput = z.infer<typeof verifyPromotionInputSchema>

export const promotionReceiptSchema = z.object({
  batchId: z.string(),
  tenantId: z.string(),
  deviceId: z.string(),
  storePath: z.string(),
  sessionCount: z.number().int().nonnegative(),
  objectCount: z.number().int().nonnegative(),
  searchDocCount: z.number().int().nonnegative(),
  declaredObjectsVerified: z.number().int().nonnegative().default(0),
  declaredSessionsVerified: z.number().int().nonnegative().default(0),
  declaredSearchDocsVerified: z.number().int().nonnegative().default(0),
  verifiedAt: z.string().datetime(),
})
export type PromotionReceipt = z.infer<typeof promotionReceiptSchema>

export const verifyPromotionOutputSchema = z.object({
  receipt: promotionReceiptSchema,
  sampledSessions: z.array(z.object({ id: z.string(), title: z.string().nullable(), turnCount: z.number().int() })),
})
export type VerifyPromotionOutput = z.infer<typeof verifyPromotionOutputSchema>

// ---------- ack cleanup ----------

export const ackCleanupInputSchema = z.object({
  batchId: z.string().min(1),
  storePath: z.string().min(1),
  removedPaths: z.array(z.string()).default([]),
})
export type AckCleanupInput = z.infer<typeof ackCleanupInputSchema>
