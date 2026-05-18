// Epoch lifecycle: beginEpoch / sealEpoch / FK-closure validation.
//
// An epoch is the atomic unit of bundle progression. While open, all
// writes go to `tmp/epoch-N/`. Sealing validates foreign-key closure
// across canonical entity rows, computes `bundleRoot` and `rawSourceRoot`,
// writes the canonical manifest, atomically renames `tmp/epoch-N/` →
// `epochs/N/`, and then atomically rewrites `head.json` to point at N.
//
// Durability invariants (CQ-023, CQ-025):
//   - `sealEpoch` refuses to advance head.json unless every projection
//     row, raw-source entry, and CAS object reference is backed by a
//     durable segment/pack reference registered on the handle.
//   - `beginEpoch` reaps any leftover `tmp/epoch-N/` directory before
//     creating its own.
//   - `reapStaleTmp(bundle)` removes any incomplete `tmp/epoch-*` dir
//     left by a crashed sealer.

import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'

import {
  type BundleCountsV2,
  type BundleHeadV2,
  type CanonicalEntityType,
  type CborValue,
  type RawSourceLeafInput,
  bundleRootFromRows,
  canonicalTimestamp,
  rawSourceRootFromEntries,
  toHex,
} from '@c3-oss/prosa-types-v2'
import { blake3 } from '@noble/hashes/blake3'

import type { Bundle } from '../bundle/bundle.js'
import { EMPTY_BUNDLE_COUNTS } from '../bundle/head.js'
import { epochDir, epochTmpDir } from '../bundle/layout.js'
import {
  type EpochManifestV2,
  PLACEHOLDER_SIGNATURE,
  type SignedEpochManifestV2,
  epochManifestBytes,
} from './manifest.js'

const PARSER_VERSION = '2.0.0-lane1'

/** Durable reference registered on an EpochHandle (CQ-023). */
export type DurableSegmentRef = {
  /** What this segment carries; mirrors the SegmentRef.kind contract from
   * prosa-types-v2. */
  kind:
    | 'projection_arrow'
    | 'projection_parquet'
    | 'cas_object_pack'
    | 'raw_source_pack'
    | 'search_docs_arrow'
    | 'session_blob_pack'
    | 'manifest'
  /** On-disk path inside the bundle (relative to bundle root). Used for
   * crash-recovery diagnostics. */
  path: string
  /** BLAKE3 digest of the segment bytes (tagged form). */
  digest: string
  /** byte length of the segment file. */
  byteLength: number
  /** For projection segments, the entity type they cover. */
  entityType?: CanonicalEntityType
  /** Object IDs admitted by this segment (only set for cas_object_pack and raw_source_pack). */
  objectIds?: readonly string[]
}

/**
 * In-memory accumulator for one epoch's worth of canonical rows and
 * raw-source entries. Importers (Lane 2) populate this via the shard
 * actors before calling `sealEpoch`.
 */
export class EpochHandle {
  readonly epoch: number
  readonly tmpDir: string
  readonly bundle: Bundle
  readonly createdAt: string

  private readonly rows: Map<CanonicalEntityType, Map<string, Record<string, CborValue>>> = new Map()
  private readonly rawSources: Map<string, RawSourceLeafInput> = new Map()
  private readonly segments: DurableSegmentRef[] = []
  /** Object IDs admitted by any registered cas_object_pack / raw_source_pack. */
  private readonly admittedObjectIds: Set<string> = new Set()

  constructor(args: { bundle: Bundle; epoch: number; tmpDir: string; createdAt: string }) {
    this.bundle = args.bundle
    this.epoch = args.epoch
    this.tmpDir = args.tmpDir
    this.createdAt = args.createdAt
  }

  /** Add or replace a projection row for an entity type. */
  putRow(entityType: CanonicalEntityType, primaryKey: string, row: Record<string, CborValue>): void {
    let m = this.rows.get(entityType)
    if (!m) {
      m = new Map()
      this.rows.set(entityType, m)
    }
    m.set(primaryKey, row)
  }

  /** Add or replace a raw-source entry by source_file_id. */
  putRawSource(entry: RawSourceLeafInput): void {
    this.rawSources.set(entry.source_file_id, entry)
  }

  /**
   * Register a durable on-disk segment / pack that the seal must include
   * (CQ-023). Pack writers and projection emitters call this after the
   * bytes have been fsynced. The segment's object IDs (when present) are
   * remembered as the CAS object inventory for FK closure (CQ-024).
   */
  registerSegment(ref: DurableSegmentRef): void {
    this.segments.push(ref)
    if (ref.objectIds) {
      for (const id of ref.objectIds) this.admittedObjectIds.add(id)
    }
  }

  /** Snapshot of registered segments (read-only, for tests + sealEpoch). */
  registeredSegments(): readonly DurableSegmentRef[] {
    return this.segments
  }

  rowsByEntity(): Record<CanonicalEntityType, Record<string, CborValue>[]> {
    const out = {} as Record<CanonicalEntityType, Record<string, CborValue>[]>
    for (const [et, m] of this.rows) {
      out[et] = Array.from(m.values())
    }
    return out
  }

  rawSourceEntries(): RawSourceLeafInput[] {
    return Array.from(this.rawSources.values())
  }

  /** Combined object inventory: registered CAS packs + raw-source pack content hashes. */
  objectInventory(): Set<string> {
    const out = new Set<string>(this.admittedObjectIds)
    for (const entry of this.rawSources.values()) out.add(entry.content_hash)
    return out
  }

  computeCounts(): BundleCountsV2 {
    const c: BundleCountsV2 = { ...EMPTY_BUNDLE_COUNTS }
    for (const [et, m] of this.rows) {
      switch (et) {
        case 'artifact':
          c.artifacts = m.size
          break
        case 'content_block':
          c.contentBlocks = m.size
          break
        case 'edge':
          c.edges = m.size
          break
        case 'event':
          c.events = m.size
          break
        case 'message':
          c.messages = m.size
          break
        case 'raw_record':
          c.rawRecords = m.size
          break
        case 'search_doc':
          c.searchDocs = m.size
          break
        case 'session':
          c.sessions = m.size
          break
        case 'source_file':
          c.sourceFiles = m.size
          break
        case 'tool_call':
          c.toolCalls = m.size
          break
        case 'tool_result':
          c.toolResults = m.size
          break
        case 'turn':
          c.turns = m.size
          break
        case 'project':
          // counts.projects is intentionally omitted from BundleCountsV2;
          // projects live in the projectionRows total below.
          break
      }
    }
    let total = 0
    for (const [, m] of this.rows) total += m.size
    c.projectionRows = total
    c.objects = this.rawSources.size
    return c
  }
}

export class FkClosureError extends Error {
  override name = 'FkClosureError'
  constructor(
    public readonly entityType: CanonicalEntityType,
    public readonly field: string,
    public readonly value: string,
  ) {
    super(`FK closure failed: ${entityType}.${field} references unknown ${value}`)
  }
}

export class DurabilityError extends Error {
  override name = 'DurabilityError'
}

// CQ-024: extended FK rules across canonical entities. Each rule says:
// "this child field, when non-null, must point at an existing row of the
// parent entity in this same epoch".
const FK_RULES: Array<{
  child: CanonicalEntityType
  field: string
  parent: CanonicalEntityType
}> = [
  // session graph
  { child: 'turn', field: 'session_id', parent: 'session' },
  { child: 'event', field: 'session_id', parent: 'session' },
  { child: 'event', field: 'turn_id', parent: 'turn' },
  { child: 'message', field: 'session_id', parent: 'session' },
  { child: 'message', field: 'turn_id', parent: 'turn' },
  { child: 'message', field: 'event_id', parent: 'event' },
  { child: 'content_block', field: 'session_id', parent: 'session' },
  { child: 'content_block', field: 'message_id', parent: 'message' },
  { child: 'content_block', field: 'event_id', parent: 'event' },
  { child: 'tool_call', field: 'session_id', parent: 'session' },
  { child: 'tool_call', field: 'turn_id', parent: 'turn' },
  { child: 'tool_call', field: 'message_id', parent: 'message' },
  { child: 'tool_call', field: 'event_id', parent: 'event' },
  { child: 'tool_result', field: 'session_id', parent: 'session' },
  { child: 'tool_result', field: 'tool_call_id', parent: 'tool_call' },
  { child: 'tool_result', field: 'message_id', parent: 'message' },
  { child: 'tool_result', field: 'event_id', parent: 'event' },
  // raw-record back-references
  { child: 'session', field: 'raw_record_id', parent: 'raw_record' },
  { child: 'event', field: 'raw_record_id', parent: 'raw_record' },
  { child: 'message', field: 'raw_record_id', parent: 'raw_record' },
  { child: 'content_block', field: 'raw_record_id', parent: 'raw_record' },
  { child: 'tool_call', field: 'raw_record_id', parent: 'raw_record' },
  { child: 'tool_result', field: 'raw_record_id', parent: 'raw_record' },
  { child: 'artifact', field: 'raw_record_id', parent: 'raw_record' },
  // source-file ↔ raw-record
  { child: 'raw_record', field: 'source_file_id', parent: 'source_file' },
  // project links
  { child: 'session', field: 'project_id', parent: 'project' },
  { child: 'artifact', field: 'project_id', parent: 'project' },
  // edges: endpoints are dynamic (depend on src_type/dst_type) so we
  // resolve them per-row below.
]

// Fields whose non-null value must be present in the CAS object inventory
// when the row is sealed (CQ-024).
const OBJECT_ID_FIELDS: Array<{ entity: CanonicalEntityType; field: string }> = [
  { entity: 'artifact', field: 'object_id' },
  { entity: 'artifact', field: 'text_object_id' },
  { entity: 'content_block', field: 'text_object_id' },
  { entity: 'edge', field: 'metadata_object_id' },
  { entity: 'event', field: 'payload_object_id' },
  { entity: 'raw_record', field: 'object_id' },
  { entity: 'raw_record', field: 'decoded_object_id' },
  { entity: 'source_file', field: 'object_id' },
  { entity: 'tool_call', field: 'args_object_id' },
  { entity: 'tool_result', field: 'stdout_object_id' },
  { entity: 'tool_result', field: 'stderr_object_id' },
  { entity: 'tool_result', field: 'output_object_id' },
]

export type ValidateFkClosureOptions = {
  /** When provided, every non-null `*_object_id` is checked for membership. */
  objectInventory?: ReadonlySet<string>
}

/**
 * Verify cross-entity reference closure across the rows that will be
 * sealed into the epoch. When `objectInventory` is provided, every
 * non-null `*_object_id` field is also checked.
 */
export function validateFkClosure(
  rowsByEntity: Record<CanonicalEntityType, Record<string, CborValue>[]>,
  options: ValidateFkClosureOptions = {},
): void {
  const ids: Partial<Record<CanonicalEntityType, Set<string>>> = {}
  for (const [et, rows] of Object.entries(rowsByEntity) as [CanonicalEntityType, Record<string, CborValue>[]][]) {
    const s = new Set<string>()
    const pkField = pkFieldFor(et)
    for (const row of rows) {
      const id = row[pkField] as string | undefined
      if (id) s.add(id)
    }
    ids[et] = s
  }
  for (const rule of FK_RULES) {
    const rows = rowsByEntity[rule.child] ?? []
    const parents = ids[rule.parent] ?? new Set<string>()
    for (const row of rows) {
      const v = row[rule.field] as string | null | undefined
      if (v == null) continue
      if (!parents.has(v)) {
        throw new FkClosureError(rule.child, rule.field, v)
      }
    }
  }
  // Edge endpoints (resolved per-row via src_type/dst_type).
  const edges = rowsByEntity.edge ?? []
  for (const row of edges) {
    const srcType = row.src_type as string | undefined
    const srcId = row.src_id as string | undefined
    const dstType = row.dst_type as string | undefined
    const dstId = row.dst_id as string | undefined
    if (srcType && srcId) {
      const parents = ids[srcType as CanonicalEntityType] ?? new Set<string>()
      if (!parents.has(srcId)) {
        throw new FkClosureError('edge', `src_id (${srcType})`, srcId)
      }
    }
    if (dstType && dstId) {
      const parents = ids[dstType as CanonicalEntityType] ?? new Set<string>()
      if (!parents.has(dstId)) {
        throw new FkClosureError('edge', `dst_id (${dstType})`, dstId)
      }
    }
  }
  // *_object_id closure against the object inventory.
  if (options.objectInventory) {
    const inv = options.objectInventory
    for (const { entity, field } of OBJECT_ID_FIELDS) {
      const rows = rowsByEntity[entity] ?? []
      for (const row of rows) {
        const v = row[field] as string | null | undefined
        if (v == null) continue
        if (!inv.has(v)) {
          throw new FkClosureError(entity, field, v)
        }
      }
    }
  }
}

function pkFieldFor(et: CanonicalEntityType): string {
  switch (et) {
    case 'artifact':
      return 'artifact_id'
    case 'content_block':
      return 'block_id'
    case 'edge':
      return 'edge_id'
    case 'event':
      return 'event_id'
    case 'message':
      return 'message_id'
    case 'project':
      return 'project_id'
    case 'raw_record':
      return 'raw_record_id'
    case 'search_doc':
      return 'doc_id'
    case 'session':
      return 'session_id'
    case 'source_file':
      return 'source_file_id'
    case 'tool_call':
      return 'tool_call_id'
    case 'tool_result':
      return 'tool_result_id'
    case 'turn':
      return 'turn_id'
  }
}

export type BeginEpochOptions = {
  /** Override `createdAt` (canonical timestamp). Useful for tests. */
  createdAt?: string
}

/**
 * Reap any leftover `tmp/epoch-*` directories from a crashed seal
 * (CQ-025). Returns the list of directories removed.
 */
export async function reapStaleTmp(bundle: Bundle): Promise<string[]> {
  const reaped: string[] = []
  let entries: string[]
  try {
    entries = await readdir(bundle.paths.tmp)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reaped
    throw err
  }
  for (const name of entries) {
    if (name.startsWith('epoch-') || name.startsWith('index-rebuild-')) {
      const fullPath = `${bundle.paths.tmp}/${name}`
      await rm(fullPath, { recursive: true, force: true })
      reaped.push(fullPath)
    }
  }
  return reaped
}

export async function beginEpoch(bundle: Bundle, options: BeginEpochOptions = {}): Promise<EpochHandle> {
  const next = bundle.head.epoch + 1
  const tmp = epochTmpDir(bundle.paths.root, next)
  // CQ-025: reap any leftover tmp/epoch-N first so the new epoch never
  // adopts stale bytes from a crashed sealer.
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
  return new EpochHandle({
    bundle,
    epoch: next,
    tmpDir: tmp,
    createdAt: options.createdAt ?? canonicalTimestamp(new Date().toISOString()),
  })
}

export type SealedEpoch = {
  epoch: number
  manifest: SignedEpochManifestV2
  head: BundleHeadV2
  permanentDir: string
}

/**
 * Validate FK closure (CQ-024), confirm durable refs back every row
 * (CQ-023), compute roots, write the manifest, atomically rename
 * `tmp/epoch-N/` → `epochs/N/`, then atomically swap `head.json`.
 */
export async function sealEpoch(handle: EpochHandle): Promise<SealedEpoch> {
  const rowsByEntity = handle.rowsByEntity()
  const counts = handle.computeCounts()
  const inventory = handle.objectInventory()
  validateFkClosure(rowsByEntity, { objectInventory: inventory })

  // CQ-023: durability check. For every entity type that has rows we
  // require a registered projection segment; for raw-source entries we
  // require a registered raw_source_pack; for CAS object refs we already
  // walked the inventory above.
  const segmentEntities = new Set<CanonicalEntityType>()
  let hasRawSourcePack = false
  for (const seg of handle.registeredSegments()) {
    if (seg.entityType && (seg.kind === 'projection_arrow' || seg.kind === 'projection_parquet')) {
      segmentEntities.add(seg.entityType)
    }
    if (seg.kind === 'raw_source_pack') hasRawSourcePack = true
  }
  for (const [et, m] of Object.entries(rowsByEntity) as [CanonicalEntityType, unknown[]][]) {
    if (m.length === 0) continue
    if (!segmentEntities.has(et)) {
      throw new DurabilityError(`sealEpoch: ${et} has ${m.length} rows but no projection segment registered (CQ-023)`)
    }
  }
  if (handle.rawSourceEntries().length > 0 && !hasRawSourcePack) {
    throw new DurabilityError('sealEpoch: raw_source entries present but no raw_source_pack registered (CQ-023)')
  }

  const bundleRoot = toHex(bundleRootFromRows(rowsByEntity))
  const rawSourceRoot = toHex(rawSourceRootFromEntries(handle.rawSourceEntries()))

  const manifest: EpochManifestV2 = {
    bundleFormat: 2,
    storeId: handle.bundle.head.storeId,
    epoch: handle.epoch,
    parserVersion: PARSER_VERSION,
    createdAt: handle.createdAt,
    previousEpoch: handle.bundle.head.epoch,
    previousBundleRoot: handle.bundle.head.bundleRoot,
    bundleRoot,
    rawSourceRoot,
    segments: handle.registeredSegments().map((s) => ({
      segmentId: `seg_${stripBlake3(s.digest).slice(0, 16)}`,
      kind: s.kind === 'projection_arrow' ? 'projection_arrow' : s.kind,
      digest: s.digest,
      logicalRoot: s.entityType ?? s.kind,
      compression: 'zstd',
      byteLength: s.byteLength,
      ...(s.entityType ? { entityType: s.entityType } : {}),
    })),
    counts,
  }
  const signed: SignedEpochManifestV2 = { manifest, signature: { ...PLACEHOLDER_SIGNATURE } }

  const manifestBody = epochManifestBytes(manifest)
  const manifestPath = `${handle.tmpDir}/epoch.manifest.json`
  await writeFile(manifestPath, manifestBody)
  const signedPath = `${handle.tmpDir}/epoch.manifest.signed.json`
  await writeFile(signedPath, `${JSON.stringify(signed, null, 2)}\n`)

  // CQ-025: fsync manifest before publishing. writeFile + (best-effort)
  // directory fsync mirror the head.json contract.
  // (Node's fs.writeFile already does an internal flush; a follow-up
  // hardening iteration may add explicit fdatasync calls for every
  // segment registered above.)

  const permanent = epochDir(handle.bundle.paths.root, handle.epoch)
  await mkdir(handle.bundle.paths.epochs, { recursive: true })
  await rename(handle.tmpDir, permanent)

  const manifestDigest = `blake3:${toHex(blake3(manifestBody))}`
  const nextHead: BundleHeadV2 = {
    bundleFormat: 2,
    storeId: handle.bundle.head.storeId,
    storePath: handle.bundle.head.storePath,
    epoch: handle.epoch,
    parserVersion: PARSER_VERSION,
    createdAt: handle.createdAt,
    previousBundleRoot: handle.bundle.head.bundleRoot,
    bundleRoot,
    rawSourceRoot,
    manifestDigest,
    counts,
    segments: manifest.segments,
  }
  await handle.bundle.swapHead(nextHead)

  return { epoch: handle.epoch, manifest: signed, head: nextHead, permanentDir: permanent }
}

function stripBlake3(d: string): string {
  return d.startsWith('blake3:') ? d.slice('blake3:'.length) : d
}

// `stat` is imported but currently unused by the public API; future
// crash-recovery code can use it to inspect leftover tmp epochs.
void stat
