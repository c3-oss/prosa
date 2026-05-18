import { CANONICAL_ENTITY_TYPES, deriveReceiptId, isValidCanonicalTimestamp } from '@c3-oss/prosa-types-v2'
import { z } from 'zod'

export const PROTOCOL_VERSION_V2 = 2 as const

export const sourceToolSchema = z.enum(['codex', 'claude', 'cursor', 'gemini', 'hermes'])
export const confidenceSchema = z.enum(['high', 'medium', 'low'])
export const compressionSchema = z.enum(['zstd', 'none'])

export const segmentKindSchema = z.enum([
  'raw_source_pack',
  'cas_object_pack',
  'projection_arrow',
  'projection_parquet',
  'search_docs_arrow',
  'session_blob_pack',
  'manifest',
  'inventory_object',
  'inventory_projection',
])

export const canonicalEntityTypeSchema = z.enum(CANONICAL_ENTITY_TYPES as readonly [string, ...string[]])

// 32-byte hex (BLAKE3), lowercase, no prefix. Used for raw Merkle roots and
// digests carried as bare hex (e.g. `bundleRoot`).
export const hexHashSchema = z.string().regex(/^[0-9a-f]{64}$/u, 'expected 64-char lowercase hex')

// Tagged-hash form `blake3:<64-hex>` used on the wire for pack digests and
// CAS object identities. See CANONICAL.md rule 6.
export const taggedHashSchema = z.string().regex(/^blake3:[0-9a-f]{64}$/u, "expected 'blake3:<64-hex>'")

// CQ-004: named hash kinds. Schemas are aliases over the base hex/tagged
// regexes; the names exist to keep producer/consumer intent explicit at
// type-check time and surface mismatches in code review.
export const objectIdSchema = taggedHashSchema // BLAKE3 of uncompressed bytes (canonical content identity)
export const uncompressedHashSchema = taggedHashSchema // synonym of ObjectId
export const storedHashSchema = taggedHashSchema // BLAKE3 of stored (possibly compressed) bytes
export const packDigestSchema = taggedHashSchema // BLAKE3 of an entire pack file
export const objectSetRootSchema = hexHashSchema // Merkle root over a pack's sorted ObjectId set
export const bundleRootSchema = hexHashSchema // cross-entity canonical projection root (CQ-001)
export const rawSourceRootSchema = hexHashSchema // raw-source Merkle root (CQ-003)
export const manifestDigestSchema = taggedHashSchema // BLAKE3 over the manifest's serialized bytes
export const transportHashSchema = taggedHashSchema // CQ-012: BLAKE3 over bytes observed on the upload transport

// Canonical id form: starts with letter/digit, then [a-z0-9_:-]*. Uppercase
// is rejected (CQ-002).
export const canonicalIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_:-]*$/u, 'expected lowercase canonical id')

// Canonical RFC3339 UTC ms-precision timestamp with semantic validation
// (CQ-016). Regex shape AND Date.UTC round-trip both required so impossible
// dates like 2025-02-30T00:00:00.000Z are rejected.
export const canonicalTimestampSchema = z
  .string()
  .refine(isValidCanonicalTimestamp, 'expected canonical RFC3339 UTC ms instant')

// Receipt id form: `rcpt_<base32-lower-no-pad>`.
export const receiptIdSchema = z.string().regex(/^rcpt_[a-z2-7]+$/u, 'expected rcpt_<base32-lower-no-pad>')

export const segmentRefSchema = z.object({
  segmentId: canonicalIdSchema,
  kind: segmentKindSchema,
  digest: taggedHashSchema,
  logicalRoot: z.string(),
  compression: compressionSchema,
  byteLength: z.number().int().nonnegative(),
  entityType: canonicalEntityTypeSchema.optional(),
  rowCount: z.number().int().nonnegative().optional(),
  minKey: z.string().optional(),
  maxKey: z.string().optional(),
  minTimestamp: canonicalTimestampSchema.nullable().optional(),
  maxTimestamp: canonicalTimestampSchema.nullable().optional(),
  objectCount: z.number().int().nonnegative().optional(),
  objectSetRoot: objectSetRootSchema.optional(),
})

export const packRefSchema = z.object({
  pack_digest: packDigestSchema,
  kind: z.enum(['cas_object_pack', 'raw_source_pack']),
  entry_count: z.number().int().nonnegative(),
  byte_length: z.number().int().nonnegative(),
  object_set_root: objectSetRootSchema,
  standalone_large_object: z.boolean(),
})

export const rawSourcePackEntrySchema = z.object({
  source_file_id: canonicalIdSchema,
  source_tool: sourceToolSchema,
  path: z.string(),
  file_kind: z.string(),
  size_bytes: z.number().int().nonnegative(),
  mtime_ns: z.number().int().nullable(),
  content_hash: objectIdSchema,
  object_id: objectIdSchema,
  stored_offset: z.number().int().nonnegative(),
  stored_length: z.number().int().nonnegative(),
  compression: compressionSchema,
  uncompressed_hash: uncompressedHashSchema,
  uncompressed_size: z.number().int().nonnegative(),
  stored_hash: storedHashSchema,
  workspace_hint: z.string().nullable().optional(),
})

export const missingObjectPlanV2Schema = z.object({
  objectSetRoot: objectSetRootSchema,
  inventoryDigest: taggedHashSchema,
  ordering: z.literal('hash_alg_hash_hex_size_compression_ascending'),
  encoding: z.enum(['none', 'range_list', 'roaring_bitmap_zstd']),
  objectCount: z.number().int().nonnegative(),
  payloadBase64: z.string().optional(),
})

export const bundleCountsSchema = z.object({
  sourceFiles: z.number().int().nonnegative(),
  rawRecords: z.number().int().nonnegative(),
  objects: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  contentBlocks: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  toolResults: z.number().int().nonnegative(),
  artifacts: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  searchDocs: z.number().int().nonnegative(),
  projectionRows: z.number().int().nonnegative(),
})

export const bundleHeadV2Schema = z.object({
  bundleFormat: z.literal(2),
  storeId: canonicalIdSchema,
  storePath: z.string(),
  epoch: z.number().int().nonnegative(),
  parserVersion: z.string(),
  createdAt: canonicalTimestampSchema,
  previousBundleRoot: bundleRootSchema.nullable(),
  bundleRoot: bundleRootSchema,
  rawSourceRoot: rawSourceRootSchema,
  manifestDigest: manifestDigestSchema,
  counts: bundleCountsSchema,
  segments: z.array(segmentRefSchema),
})

export const promotionReceiptV2PayloadSchema = z.object({
  receiptVersion: z.literal(2),
  receiptId: receiptIdSchema,
  protocolVersion: z.literal(2),

  tenantId: canonicalIdSchema,
  storeId: canonicalIdSchema,
  storePath: z.string(),
  deviceId: canonicalIdSchema,

  issuedAt: canonicalTimestampSchema,
  serverRegion: z.string(),
  serverKeyId: z.string(),

  previousReceiptId: receiptIdSchema.nullable(),
  previousBundleRoot: bundleRootSchema.nullable(),

  bundleRoot: bundleRootSchema,
  rawSourceRoot: rawSourceRootSchema,

  counts: bundleCountsSchema,

  materialization: z.object({
    postgresCommitId: z.string(),
    searchGenerationId: z.string(),
    rowCountsByEntity: z.record(canonicalEntityTypeSchema, z.number().int().nonnegative()),
  }),

  verification: z.object({
    uploadDigestVerified: z.literal(true),
    objectHashesVerifiedAtIngest: z.literal(true),
    projectionRowsLoaded: z.literal(true),
    noPerObjectHeadRequired: z.literal(true),
    backgroundAuditEligible: z.literal(true),
  }),

  clientSignatureStatus: z.literal('absent_v2_0'),
})

// CQ-011: bind the receipt schema to the canonical receipt ID. After
// `promotionReceiptV2PayloadSchema` passes, we require
// `payload.receiptId === deriveReceiptId(payload)`. A schema-only check
// would let a producer cache or sign a payload whose declared id is not
// the canonical hash of its bytes.
export const promotionReceiptV2Schema = z
  .object({
    payload: promotionReceiptV2PayloadSchema,
    signature: z.object({
      alg: z.literal('Ed25519'),
      keyId: z.string(),
      sig: z.string(),
    }),
  })
  .superRefine((data, ctx) => {
    let expected: string
    try {
      expected = deriveReceiptId(data.payload)
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload'],
        message: `deriveReceiptId failed: ${(err as Error).message}`,
      })
      return
    }
    if (data.payload.receiptId !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'receiptId'],
        message: `receiptId ${data.payload.receiptId} does not match deriveReceiptId(payload)=${expected}`,
      })
    }
  })

export type SegmentRefWire = z.infer<typeof segmentRefSchema>
export type PackRefWire = z.infer<typeof packRefSchema>
export type RawSourcePackEntryWire = z.infer<typeof rawSourcePackEntrySchema>
export type BundleHeadV2Wire = z.infer<typeof bundleHeadV2Schema>
export type PromotionReceiptV2Wire = z.infer<typeof promotionReceiptV2Schema>
