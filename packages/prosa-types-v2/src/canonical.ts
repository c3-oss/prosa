// Canonical encoding and Merkle helpers for prosa v2.
//
// The rules implemented here are the load-bearing pin from
// `docs/rearch/17-review-of-proposal-3.md` L15. Every Merkle leaf computed
// anywhere in the system MUST go through these helpers. Any change requires
// regenerating the conformance fixture and writing a Lane 0 ADR (see
// `docs/roadmap/rearch-2/correction-queue.md`).

import { blake3 } from '@noble/hashes/blake3'

import type { CanonicalEntityType } from './common.js'
import { CANONICAL_ENTITY_TYPES } from './common.js'
import { ENTITY_PRIMARY_KEY, ENTITY_SCHEMA_ORDER } from './entities/index.js'
import { ENTITY_FIELD_KINDS, type FieldKind } from './field-kinds.js'

const LEAF_DOMAIN_PROJECTION = new TextEncoder().encode('prosa.projection.leaf.v2')
const LEAF_DOMAIN_RAW_SOURCE = new TextEncoder().encode('prosa.rawsource.leaf.v2')

const utf8 = new TextEncoder()

const ZERO_HASH = new Uint8Array(32)

// ------------------------------------------------------------------
// Timestamp canonicalization (CANONICAL.md rule 5)
// ------------------------------------------------------------------

const TIMESTAMP_LOOSE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/

const TIMESTAMP_CANONICAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * Canonicalize an RFC3339 timestamp to UTC with exactly millisecond precision,
 * truncating sub-ms fractional digits toward the epoch.
 */
export function canonicalTimestamp(input: string): string {
  const m = TIMESTAMP_LOOSE_RE.exec(input)
  if (!m) {
    throw new Error(`canonicalTimestamp: not an RFC3339 timestamp: ${input}`)
  }
  const [, y, mo, d, h, mi, s, frac = '', off = 'Z'] = m
  const ms = `${frac}000`.slice(0, 3)
  if (off === 'Z') {
    return `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`
  }
  const base = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), 0)
  const sign = off[0] === '-' ? -1 : 1
  const offHours = Number(off.slice(1, 3))
  const offMinutes = Number(off.slice(4, 6))
  const offsetMs = sign * (offHours * 60 + offMinutes) * 60_000
  const date = new Date(base - offsetMs)
  const Y = String(date.getUTCFullYear()).padStart(4, '0')
  const M = String(date.getUTCMonth() + 1).padStart(2, '0')
  const D = String(date.getUTCDate()).padStart(2, '0')
  const H = String(date.getUTCHours()).padStart(2, '0')
  const Mi = String(date.getUTCMinutes()).padStart(2, '0')
  const S = String(date.getUTCSeconds()).padStart(2, '0')
  return `${Y}-${M}-${D}T${H}:${Mi}:${S}.${ms}Z`
}

// ------------------------------------------------------------------
// Field-kind validation (CANONICAL.md rules 5, 6, CQ-002)
// ------------------------------------------------------------------

const ID_RE = /^[a-z0-9][a-z0-9_:-]*$/
const TAGGED_HASH_RE = /^blake3:[0-9a-f]{64}$/
const HEX_HASH_RE = /^[0-9a-f]{64}$/

/**
 * Validate a field value against its declared canonical kind. Throws on any
 * non-canonical input — silent normalization would let two implementations
 * compute different leaves from the same logical input.
 */
export function validateFieldValue(
  entityType: CanonicalEntityType,
  field: string,
  kind: FieldKind,
  value: CborValue,
): void {
  if (value === null || value === undefined) return
  switch (kind) {
    case 'timestamp': {
      if (typeof value !== 'string') {
        throw new Error(`merkleLeaf: ${entityType}.${field}: timestamp must be string`)
      }
      if (!TIMESTAMP_CANONICAL_RE.test(value)) {
        throw new Error(
          `merkleLeaf: ${entityType}.${field}: non-canonical timestamp ${JSON.stringify(value)}; use canonicalTimestamp() at ingest`,
        )
      }
      return
    }
    case 'id': {
      if (typeof value !== 'string') {
        throw new Error(`merkleLeaf: ${entityType}.${field}: id must be string`)
      }
      if (!ID_RE.test(value)) {
        throw new Error(
          `merkleLeaf: ${entityType}.${field}: non-canonical id ${JSON.stringify(value)}; ids must be lowercase, match [a-z0-9][a-z0-9_:-]*`,
        )
      }
      return
    }
    case 'tagged_hash': {
      if (typeof value !== 'string') {
        throw new Error(`merkleLeaf: ${entityType}.${field}: tagged_hash must be string`)
      }
      if (!TAGGED_HASH_RE.test(value)) {
        throw new Error(
          `merkleLeaf: ${entityType}.${field}: non-canonical tagged_hash ${JSON.stringify(value)}; must match 'blake3:<64-lowercase-hex>'`,
        )
      }
      return
    }
    case 'hex_hash': {
      if (typeof value !== 'string') {
        throw new Error(`merkleLeaf: ${entityType}.${field}: hex_hash must be string`)
      }
      if (!HEX_HASH_RE.test(value)) {
        throw new Error(
          `merkleLeaf: ${entityType}.${field}: non-canonical hex_hash ${JSON.stringify(value)}; must be 64 lowercase hex digits`,
        )
      }
      return
    }
    case 'integer': {
      if (typeof value !== 'number' && typeof value !== 'bigint') {
        throw new Error(`merkleLeaf: ${entityType}.${field}: integer must be number or bigint, got ${typeof value}`)
      }
      return
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        throw new Error(`merkleLeaf: ${entityType}.${field}: boolean must be true|false, got ${typeof value}`)
      }
      return
    }
    case 'enum':
    case 'string': {
      if (typeof value !== 'string') {
        throw new Error(`merkleLeaf: ${entityType}.${field}: ${kind} must be string`)
      }
      return
    }
  }
}

// ------------------------------------------------------------------
// Canonical CBOR encoder (RFC 8949 §4.2.1 deterministic subset)
// ------------------------------------------------------------------

export type CborValue = null | undefined | boolean | number | bigint | string | CborValue[]

function writeArgument(major: number, value: bigint): Uint8Array {
  const tag = major << 5
  if (value < 0n) throw new Error('writeArgument: negative argument')
  if (value < 24n) return Uint8Array.of(tag | Number(value))
  if (value < 0x100n) return Uint8Array.of(tag | 24, Number(value))
  if (value < 0x10000n) {
    const v = Number(value)
    return Uint8Array.of(tag | 25, (v >> 8) & 0xff, v & 0xff)
  }
  if (value < 0x100000000n) {
    const v = Number(value)
    return Uint8Array.of(tag | 26, (v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff)
  }
  const out = new Uint8Array(9)
  out[0] = tag | 27
  let v = value
  for (let i = 7; i >= 0; i--) {
    out[1 + i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

function encodeInteger(n: number | bigint): Uint8Array {
  let bi: bigint
  if (typeof n === 'bigint') {
    bi = n
  } else {
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new Error(`canonicalCbor: integer fields must be safe integers, got ${n}`)
    }
    if (!Number.isSafeInteger(n)) {
      throw new Error(`canonicalCbor: integer ${n} exceeds Number.MAX_SAFE_INTEGER; pass as bigint`)
    }
    bi = BigInt(n)
  }
  if (bi >= 0n) return writeArgument(0, bi)
  return writeArgument(1, -1n - bi)
}

function encodeString(s: string): Uint8Array {
  const normalized = s.normalize('NFC')
  const bytes = utf8.encode(normalized)
  const header = writeArgument(3, BigInt(bytes.length))
  return concat(header, bytes)
}

function encodeArray(items: readonly CborValue[]): Uint8Array {
  const header = writeArgument(4, BigInt(items.length))
  const pieces: Uint8Array[] = [header]
  for (const item of items) pieces.push(encodeCbor(item))
  return concat(...pieces)
}

function encodeCbor(value: CborValue): Uint8Array {
  if (value === null || value === undefined) return Uint8Array.of(0xf6)
  if (value === false) return Uint8Array.of(0xf4)
  if (value === true) return Uint8Array.of(0xf5)
  if (typeof value === 'number' || typeof value === 'bigint') return encodeInteger(value)
  if (typeof value === 'string') return encodeString(value)
  if (Array.isArray(value)) return encodeArray(value)
  throw new Error(`canonicalCbor: unsupported value type: ${typeof value}`)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/**
 * Encode an entity row tuple as canonical CBOR. Missing object keys encode
 * as null (CANONICAL.md rule 2). `row` may be a record or a pre-ordered
 * tuple.
 */
export function canonicalCbor(
  row: Record<string, CborValue> | readonly CborValue[],
  fieldOrder?: readonly string[],
): Uint8Array {
  let tuple: CborValue[]
  if (Array.isArray(row)) {
    tuple = [...row]
  } else {
    if (!fieldOrder) {
      throw new Error('canonicalCbor: fieldOrder is required for object inputs')
    }
    tuple = fieldOrder.map((field) => {
      const v = (row as Record<string, CborValue>)[field]
      return v === undefined ? null : v
    })
  }
  return encodeArray(tuple)
}

// ------------------------------------------------------------------
// Projection Merkle leaves and roots (CANONICAL.md rules 7-10)
// ------------------------------------------------------------------

/**
 * Compute the 32-byte BLAKE3 leaf for a canonical entity row.
 *
 * leaf = blake3('prosa.projection.leaf.v2' || entity_type || primary_key || canonicalCbor(row))
 *
 * Per CQ-002, every field value is validated against its `FieldKind`
 * before encoding; non-canonical timestamps/ids/hashes throw.
 */
export function merkleLeaf(
  entityType: CanonicalEntityType,
  row: Record<string, CborValue>,
  primaryKey?: string,
): Uint8Array {
  const fieldOrder = ENTITY_SCHEMA_ORDER[entityType]
  const keyField = ENTITY_PRIMARY_KEY[entityType]
  const kinds = ENTITY_FIELD_KINDS[entityType]
  const key = primaryKey ?? (row[keyField] as string | undefined)
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`merkleLeaf: missing primary key '${keyField}' for entity '${entityType}'`)
  }
  // Validate every declared field; this enforces CANONICAL.md rules 5 and 6.
  for (const field of fieldOrder) {
    const kind = kinds[field] ?? 'string'
    validateFieldValue(entityType, field, kind, row[field])
  }
  const encodedRow = canonicalCbor(row, fieldOrder)
  const buf = concat(LEAF_DOMAIN_PROJECTION, utf8.encode(entityType), utf8.encode(key), encodedRow)
  return blake3(buf)
}

/**
 * Build a binary Merkle root from a list of 32-byte leaves. Empty input
 * returns 32 zero bytes. Odd levels duplicate the last leaf.
 */
export function merkleRoot(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return new Uint8Array(ZERO_HASH)
  let level: Uint8Array[] = leaves.map((l) => {
    if (l.length !== 32) throw new Error(`merkleRoot: leaf must be 32 bytes, got ${l.length}`)
    return l
  })
  while (level.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as Uint8Array
      const right = (i + 1 < level.length ? level[i + 1] : level[i]) as Uint8Array
      next.push(blake3(concat(left, right)))
    }
    level = next
  }
  return level[0] as Uint8Array
}

/**
 * Sort rows by primary key bytewise ASCENDING, compute leaves, return the
 * subroot for this entity type.
 */
export function merkleSubroot(entityType: CanonicalEntityType, rows: readonly Record<string, CborValue>[]): Uint8Array {
  if (rows.length === 0) return new Uint8Array(ZERO_HASH)
  const keyField = ENTITY_PRIMARY_KEY[entityType]
  const sorted = [...rows].sort((a, b) => {
    const ak = (a[keyField] as string) ?? ''
    const bk = (b[keyField] as string) ?? ''
    return compareBytewise(ak, bk)
  })
  const leaves = sorted.map((row) => merkleLeaf(entityType, row))
  return merkleRoot(leaves)
}

/**
 * Compose subroots across entity types in CANONICAL_ENTITY_TYPES order
 * (alphabetical, rule 7) into the cross-entity bundle Merkle root (rule 10).
 *
 * This IS `bundleRoot` for a populated bundle: callers compute each subroot
 * from their canonical projection rows and pass the map in. Missing entity
 * types contribute 32 zero bytes.
 */
export function crossEntityRoot(subroots: Partial<Record<CanonicalEntityType, Uint8Array>>): Uint8Array {
  const ordered: Uint8Array[] = CANONICAL_ENTITY_TYPES.map((et) => subroots[et] ?? new Uint8Array(ZERO_HASH))
  return merkleRoot(ordered)
}

/**
 * Convenience: compute `bundleRoot` from a `Partial<Record<CanonicalEntityType, rows>>`
 * directly, doing the per-entity subroot computation. The bundleRoot pinned
 * by CANONICAL.md rule 10.
 */
export function bundleRootFromRows(
  rowsByEntity: Partial<Record<CanonicalEntityType, readonly Record<string, CborValue>[]>>,
): Uint8Array {
  const subroots: Partial<Record<CanonicalEntityType, Uint8Array>> = {}
  for (const et of CANONICAL_ENTITY_TYPES) {
    const rows = rowsByEntity[et]
    if (rows && rows.length > 0) {
      subroots[et] = merkleSubroot(et, rows)
    }
  }
  return crossEntityRoot(subroots)
}

// ------------------------------------------------------------------
// Raw-source leaves and root (CANONICAL.md rule 11, CQ-003)
// ------------------------------------------------------------------

export type RawSourceLeafInput = {
  source_file_id: string
  content_hash: string // ObjectId, tagged-hash form
  uncompressed_size: number
  compression: 'zstd' | 'none'
  stored_hash: string // StoredHash, tagged-hash form
}

/**
 * Compute the BLAKE3 leaf for one raw-source-pack entry.
 *
 * leaf = blake3(
 *   'prosa.rawsource.leaf.v2' || source_file_id
 *   || canonicalCbor([content_hash, uncompressed_size, compression, stored_hash])
 * )
 *
 * Validates the field shapes (CQ-002) so producers can't compute leaves
 * over non-canonical inputs.
 */
export function rawSourceLeaf(entry: RawSourceLeafInput): Uint8Array {
  if (!ID_RE.test(entry.source_file_id)) {
    throw new Error(`rawSourceLeaf: source_file_id ${JSON.stringify(entry.source_file_id)} not canonical`)
  }
  if (!TAGGED_HASH_RE.test(entry.content_hash)) {
    throw new Error(`rawSourceLeaf: content_hash ${JSON.stringify(entry.content_hash)} not canonical tagged_hash`)
  }
  if (!TAGGED_HASH_RE.test(entry.stored_hash)) {
    throw new Error(`rawSourceLeaf: stored_hash ${JSON.stringify(entry.stored_hash)} not canonical tagged_hash`)
  }
  if (!Number.isSafeInteger(entry.uncompressed_size) || entry.uncompressed_size < 0) {
    throw new Error('rawSourceLeaf: uncompressed_size must be non-negative safe integer')
  }
  if (entry.compression !== 'zstd' && entry.compression !== 'none') {
    throw new Error(`rawSourceLeaf: compression must be 'zstd' | 'none'`)
  }
  const encoded = canonicalCbor([entry.content_hash, entry.uncompressed_size, entry.compression, entry.stored_hash])
  return blake3(concat(LEAF_DOMAIN_RAW_SOURCE, utf8.encode(entry.source_file_id), encoded))
}

/**
 * Compute `rawSourceRoot` over a set of raw-source entries (CANONICAL.md
 * rule 11). Entries are sorted by `source_file_id` ASC bytewise.
 */
export function rawSourceRootFromEntries(entries: readonly RawSourceLeafInput[]): Uint8Array {
  if (entries.length === 0) return new Uint8Array(ZERO_HASH)
  const sorted = [...entries].sort((a, b) => compareBytewise(a.source_file_id, b.source_file_id))
  const leaves = sorted.map(rawSourceLeaf)
  return merkleRoot(leaves)
}

// ------------------------------------------------------------------
// Receipt payload bytes (CANONICAL.md rule 12, CQ-005)
// ------------------------------------------------------------------

// Field-order tuples for the nested receipt payload structures. These are
// load-bearing: any reorder flips every `receiptId`.

export const BUNDLE_COUNTS_FIELDS = [
  'sourceFiles',
  'rawRecords',
  'objects',
  'sessions',
  'turns',
  'events',
  'messages',
  'contentBlocks',
  'toolCalls',
  'toolResults',
  'artifacts',
  'edges',
  'searchDocs',
  'projectionRows',
] as const

export const MATERIALIZATION_FIELDS = [
  'postgresCommitId',
  'searchGenerationId',
  'rowCountsByEntity', // CANONICAL_ENTITY_TYPES-ordered integer array
] as const

export const VERIFICATION_FIELDS = [
  'uploadDigestVerified',
  'objectHashesVerifiedAtIngest',
  'projectionRowsLoaded',
  'noPerObjectHeadRequired',
  'backgroundAuditEligible',
] as const

export const RECEIPT_PAYLOAD_FIELDS = [
  'receiptVersion',
  'receiptId',
  'protocolVersion',
  'tenantId',
  'storeId',
  'storePath',
  'deviceId',
  'issuedAt',
  'serverRegion',
  'serverKeyId',
  'previousReceiptId',
  'previousBundleRoot',
  'bundleRoot',
  'rawSourceRoot',
  'counts', // nested array via BUNDLE_COUNTS_FIELDS
  'materialization', // nested array via MATERIALIZATION_FIELDS
  'verification', // nested array via VERIFICATION_FIELDS
  'clientSignatureStatus',
] as const

type CountsObject = Record<(typeof BUNDLE_COUNTS_FIELDS)[number], number>

type MaterializationObject = {
  postgresCommitId: string
  searchGenerationId: string
  rowCountsByEntity: Record<CanonicalEntityType, number>
}

type VerificationObject = Record<(typeof VERIFICATION_FIELDS)[number], boolean>

type ReceiptPayloadLike = {
  receiptVersion: number
  receiptId: string
  protocolVersion: number
  tenantId: string
  storeId: string
  storePath: string
  deviceId: string
  issuedAt: string
  serverRegion: string
  serverKeyId: string
  previousReceiptId: string | null
  previousBundleRoot: string | null
  bundleRoot: string
  rawSourceRoot: string
  counts: CountsObject
  materialization: MaterializationObject
  verification: VerificationObject
  clientSignatureStatus: string
}

function encodeCountsTuple(counts: CountsObject): CborValue[] {
  return BUNDLE_COUNTS_FIELDS.map((f) => counts[f])
}

function encodeMaterializationTuple(m: MaterializationObject): CborValue[] {
  // rowCountsByEntity is encoded as the CANONICAL_ENTITY_TYPES-ordered
  // integer array (no map encoding). Missing entries are 0.
  const rowCounts: CborValue[] = CANONICAL_ENTITY_TYPES.map((et) => m.rowCountsByEntity[et] ?? 0)
  return [m.postgresCommitId, m.searchGenerationId, rowCounts]
}

function encodeVerificationTuple(v: VerificationObject): CborValue[] {
  return VERIFICATION_FIELDS.map((f) => v[f])
}

/**
 * Deterministic byte encoding for a `PromotionReceiptV2Payload`. Used as
 * the input to `receiptId` hashing and to the server's KMS signature.
 *
 * Note: when computing `receiptId` from a payload, the `receiptId` field
 * itself is included as the empty string per the lane contract (the ID is
 * not known until the bytes are hashed). Pass `payload.receiptId = ''`
 * (or omit it) when seeding the hash; pass the populated payload for
 * signature verification.
 */
export function receiptPayloadBytes(payload: ReceiptPayloadLike): Uint8Array {
  const tuple: CborValue[] = RECEIPT_PAYLOAD_FIELDS.map((f) => {
    const v = payload[f]
    if (f === 'counts') return encodeCountsTuple(v as CountsObject)
    if (f === 'materialization') return encodeMaterializationTuple(v as MaterializationObject)
    if (f === 'verification') return encodeVerificationTuple(v as VerificationObject)
    return v as CborValue
  })
  return canonicalCbor(tuple)
}

/**
 * Derive the canonical `receiptId` from a payload. The `receiptId` field on
 * the payload is zeroed (set to '') during hashing, then the resulting
 * blake3 digest is base32-encoded (RFC 4648 alphabet, lowercase, no
 * padding) and prefixed with `rcpt_`.
 */
export function deriveReceiptId(payload: ReceiptPayloadLike): string {
  const seed: ReceiptPayloadLike = { ...payload, receiptId: '' }
  const bytes = receiptPayloadBytes(seed)
  return `rcpt_${base32LowerNoPad(blake3(bytes))}`
}

// ------------------------------------------------------------------
// Idempotency key derivation (CANONICAL.md rule 13, CQ-006)
// ------------------------------------------------------------------

const ZERO = Uint8Array.of(0x00)

export type DeriveSourceFileIdInput = {
  source_tool: string
  path: string // NFC-normalized absolute path
  content_hash: string // ObjectId tagged form: 'blake3:<hex>'
}

export function deriveSourceFileId(input: DeriveSourceFileIdInput): string {
  if (!TAGGED_HASH_RE.test(input.content_hash)) {
    throw new Error('deriveSourceFileId: content_hash must be tagged-hash form')
  }
  const buf = concat(
    utf8.encode(input.source_tool),
    ZERO,
    utf8.encode(input.path.normalize('NFC')),
    ZERO,
    utf8.encode(input.content_hash),
  )
  return `src_${base32LowerNoPad(blake3(buf))}`
}

export type DeriveRawRecordIdInput = {
  source_tool: string
  source_file_id: string
  ordinal: number | bigint
  record_kind: string
}

export function deriveRawRecordId(input: DeriveRawRecordIdInput): string {
  if (!ID_RE.test(input.source_file_id)) {
    throw new Error('deriveRawRecordId: source_file_id must be canonical id')
  }
  const ord = typeof input.ordinal === 'bigint' ? input.ordinal : BigInt(input.ordinal as number)
  if (ord < 0n) throw new Error('deriveRawRecordId: ordinal must be non-negative')
  const ordBytes = new Uint8Array(8)
  let v = ord
  for (let i = 7; i >= 0; i--) {
    ordBytes[i] = Number(v & 0xffn)
    v >>= 8n
  }
  const buf = concat(
    utf8.encode(input.source_tool),
    ZERO,
    utf8.encode(input.source_file_id),
    ZERO,
    ordBytes,
    ZERO,
    utf8.encode(input.record_kind),
  )
  return `raw_${base32LowerNoPad(blake3(buf))}`
}

// ------------------------------------------------------------------
// Utility helpers
// ------------------------------------------------------------------

function compareBytewise(a: string, b: string): number {
  const ab = utf8.encode(a)
  const bb = utf8.encode(b)
  const len = Math.min(ab.length, bb.length)
  for (let i = 0; i < len; i++) {
    const av = ab[i] as number
    const bv = bb[i] as number
    if (av !== bv) return av - bv
  }
  return ab.length - bb.length
}

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/**
 * Lowercase base32 (RFC 4648 alphabet) without padding. Used for IDs derived
 * from BLAKE3 digests.
 */
export function base32LowerNoPad(bytes: Uint8Array): string {
  let out = ''
  let buffer = 0
  let bits = 0
  for (const b of bytes) {
    buffer = (buffer << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32_ALPHABET[(buffer >> bits) & 0x1f]
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f]
  }
  return out
}
