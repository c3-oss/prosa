// Epoch lifecycle: beginEpoch / sealEpoch / FK-closure validation / ref
// durability check.
//
// Durability + integrity invariants (across CQ-023..CQ-027 and
// CQ-031..CQ-035):
//
//   1. While open, every epoch byte goes to `tmp/epoch-N/`.
//   2. `beginEpoch` reaps any leftover `tmp/epoch-N/` directory before
//      creating its own (CQ-025).
//   3. `sealEpoch` walks every registered durable ref and verifies:
//        - the path exists and is under the bundle root (no escapes);
//        - the byte length matches the declared `byteLength`;
//        - BLAKE3 of the bytes matches the declared `digest`;
//        - for CAS packs, the bytes pass `verifyCasPack` (which now also
//          checks the canonical-header bytes — CQ-035 — and the
//          self-referential `pack_digest` — CQ-026);
//        - for raw-source packs, the bytes pass `verifyRawSourcePack`;
//        - for projection segments, the bytes equal
//          `writeProjectionSegment(entity, rowsByEntity[entity])` would
//          have produced — proving the segment carries exactly the rows
//          being sealed (CQ-031).
//   4. FK closure validates the canonical graph (CQ-024 + CQ-033) and
//      `*_object_id` references against the **separated** CAS / raw-source
//      inventories (CQ-032). The current implementation enforces a
//      current-epoch policy: every parent reference must resolve inside
//      the same epoch's rows.
//   5. The manifest is written durably (writeFileDurable) and the
//      surrounding directories are fsynced before `head.json` is
//      published via `swapHead` (CQ-034).
//
// `reapStaleTmp(bundle)` is wired into `Bundle.open()` so that any
// crashed sealer or rebuilder leaves no half-written bytes behind.

import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, sep } from 'node:path'

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
import { verifyCasPack } from '../pack/cas-pack.js'
import { verifyRawSourcePack } from '../pack/raw-source-pack.js'
import { syncDir, writeFileDurable } from '../util/durable-write.js'
import {
  type EpochManifestV2,
  PLACEHOLDER_SIGNATURE,
  type SignedEpochManifestV2,
  epochManifestBytes,
} from './manifest.js'

const PARSER_VERSION = '2.0.0-lane1'

/** Durable reference registered on an EpochHandle. */
export type DurableSegmentRef = {
  kind:
    | 'projection_arrow'
    | 'projection_parquet'
    | 'cas_object_pack'
    | 'raw_source_pack'
    | 'search_docs_arrow'
    | 'session_blob_pack'
    | 'manifest'
  /** Absolute on-disk path inside the bundle. */
  path: string
  /** BLAKE3 digest of the segment bytes (tagged form). */
  digest: string
  byteLength: number
  /** For projection segments, the entity type they cover. */
  entityType?: CanonicalEntityType
  /**
   * Object IDs admitted by this segment. Lane 1 ignores this field on
   * raw_source_pack refs (CQ-032: raw-source content_hashes are derived
   * from the verified pack, not from caller claims). It is retained on
   * the type so cas_object_pack writers can still declare what they
   * carry; CAS object inventory is recomputed from `verifyCasPack`.
   */
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

  constructor(args: { bundle: Bundle; epoch: number; tmpDir: string; createdAt: string }) {
    this.bundle = args.bundle
    this.epoch = args.epoch
    this.tmpDir = args.tmpDir
    this.createdAt = args.createdAt
  }

  putRow(entityType: CanonicalEntityType, primaryKey: string, row: Record<string, CborValue>): void {
    let m = this.rows.get(entityType)
    if (!m) {
      m = new Map()
      this.rows.set(entityType, m)
    }
    m.set(primaryKey, row)
  }

  putRawSource(entry: RawSourceLeafInput): void {
    this.rawSources.set(entry.source_file_id, entry)
  }

  /**
   * Register a durable on-disk segment/pack reference. The seal walks
   * every registered ref and verifies it against the bytes on disk; this
   * registration is a *claim*, not a trust boundary.
   */
  registerSegment(ref: DurableSegmentRef): void {
    this.segments.push(ref)
  }

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

// CQ-024 + CQ-033: FK rules across the canonical graph. Each rule says
// "this child field, when non-null, must point at an existing row of the
// parent entity in this same epoch (current-epoch policy)".
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
  { child: 'message', field: 'parent_message_id', parent: 'message' }, // CQ-033
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
  { child: 'edge', field: 'raw_record_id', parent: 'raw_record' }, // CQ-033
  // source-file ↔ raw-record
  { child: 'raw_record', field: 'source_file_id', parent: 'source_file' },
  // project links
  { child: 'session', field: 'project_id', parent: 'project' },
  { child: 'artifact', field: 'project_id', parent: 'project' },
  { child: 'artifact', field: 'session_id', parent: 'session' }, // CQ-033
  // session parent (intra-entity)
  { child: 'session', field: 'parent_session_id', parent: 'session' }, // CQ-033
  // CQ-041: search_doc nullable parent refs.
  { child: 'search_doc', field: 'session_id', parent: 'session' },
  { child: 'search_doc', field: 'project_id', parent: 'project' },
  // Edge endpoints and search_doc entity refs are resolved per-row via
  // src_type/dst_type and entity_type below.
]

// CQ-032: split inventory categories. Each `*_object_id` field declares
// which inventory backs it.
type ObjectRefInventory = 'cas' | 'raw_source'

const OBJECT_ID_FIELDS: Array<{
  entity: CanonicalEntityType
  field: string
  inventory: ObjectRefInventory
}> = [
  // CAS object refs — must come from a verified `cas_object_pack`.
  { entity: 'artifact', field: 'object_id', inventory: 'cas' },
  { entity: 'artifact', field: 'text_object_id', inventory: 'cas' },
  { entity: 'content_block', field: 'text_object_id', inventory: 'cas' },
  { entity: 'edge', field: 'metadata_object_id', inventory: 'cas' },
  { entity: 'event', field: 'payload_object_id', inventory: 'cas' },
  { entity: 'raw_record', field: 'decoded_object_id', inventory: 'cas' },
  { entity: 'tool_call', field: 'args_object_id', inventory: 'cas' },
  { entity: 'tool_result', field: 'stdout_object_id', inventory: 'cas' },
  { entity: 'tool_result', field: 'stderr_object_id', inventory: 'cas' },
  { entity: 'tool_result', field: 'output_object_id', inventory: 'cas' },
  // Raw-source refs — the bytes ARE the source-file bytes, indexed by
  // content_hash inside a verified `raw_source_pack`.
  { entity: 'source_file', field: 'object_id', inventory: 'raw_source' },
  { entity: 'source_file', field: 'content_hash', inventory: 'raw_source' },
  { entity: 'raw_record', field: 'object_id', inventory: 'raw_source' },
  { entity: 'raw_record', field: 'content_hash', inventory: 'raw_source' },
]

export type ValidateFkClosureOptions = {
  casObjectInventory?: ReadonlySet<string>
  rawSourceInventory?: ReadonlySet<string>
}

/**
 * Verify cross-entity reference closure across the rows that will be
 * sealed into the epoch.
 *
 * Prior-epoch policy (CQ-033): every parent reference must resolve
 * inside the current epoch's rows. Lane 1 does not implement a
 * cross-epoch inventory; importers that intentionally reference a row
 * from a prior epoch must restage that row in the current epoch.
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
  // CQ-033: search_doc.entity_type/entity_id resolved per-row.
  const searchDocs = rowsByEntity.search_doc ?? []
  for (const row of searchDocs) {
    const t = row.entity_type as string | undefined
    const id = row.entity_id as string | undefined
    if (t && id) {
      const parents = ids[t as CanonicalEntityType] ?? new Set<string>()
      if (!parents.has(id)) {
        throw new FkClosureError('search_doc', `entity_id (${t})`, id)
      }
    }
  }
  // CQ-032: split `*_object_id` closure across CAS / raw-source inventories.
  // When the caller passes ANY inventory we enforce BOTH categories so a
  // ref cannot accidentally satisfy through the wrong inventory. Missing
  // category defaults to the empty set (fail-closed for that category).
  const inventoryProvided = options.casObjectInventory !== undefined || options.rawSourceInventory !== undefined
  if (inventoryProvided) {
    const cas = options.casObjectInventory ?? new Set<string>()
    const raw = options.rawSourceInventory ?? new Set<string>()
    for (const { entity, field, inventory } of OBJECT_ID_FIELDS) {
      const inv = inventory === 'cas' ? cas : raw
      const rows = rowsByEntity[entity] ?? []
      for (const row of rows) {
        const v = row[field] as string | null | undefined
        if (v == null) continue
        if (!inv.has(v)) {
          throw new FkClosureError(entity, `${field} (${inventory})`, v)
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
  createdAt?: string
}

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

export type VerifiedRawSourceEntry = {
  source_file_id: string
  content_hash: string
  object_id: string
  uncompressed_size: number
  stored_offset: number
  stored_length: number
  stored_hash: string
  compression: 'zstd' | 'none'
  pack_digest: string
}

type VerifiedSegments = {
  casObjects: Set<string>
  /** content_hashes admitted by verified raw_source_pack refs. */
  rawSourceContent: Set<string>
  /** Full verified raw-source inventory keyed by source_file_id (CQ-037). */
  rawSourceInventory: Map<string, VerifiedRawSourceEntry>
  projectionEntities: Set<CanonicalEntityType>
  hasRawSourcePack: boolean
}

async function verifyRegisteredSegments(
  handle: EpochHandle,
  rowsByEntity: Record<CanonicalEntityType, Record<string, CborValue>[]>,
): Promise<VerifiedSegments> {
  const out: VerifiedSegments = {
    casObjects: new Set<string>(),
    rawSourceContent: new Set<string>(),
    rawSourceInventory: new Map<string, VerifiedRawSourceEntry>(),
    projectionEntities: new Set<CanonicalEntityType>(),
    hasRawSourcePack: false,
  }
  const bundleRootAbs = await realpath(handle.bundle.paths.root)
  for (const ref of handle.registeredSegments()) {
    if (!isAbsolute(ref.path)) {
      throw new DurabilityError(`sealEpoch: ref path is not absolute: ${ref.path}`)
    }
    // CQ-038: reject symlinks. `lstat` reveals the symlink itself
    // without following; if it's a symlink we refuse.
    let ls: Awaited<ReturnType<typeof lstat>>
    try {
      ls = await lstat(ref.path)
    } catch {
      throw new DurabilityError(`sealEpoch: ref path does not exist: ${ref.path}`)
    }
    if (ls.isSymbolicLink()) {
      throw new DurabilityError(`sealEpoch: ref ${ref.path} is a symlink — refused`)
    }
    // Resolve via realpath to neutralise any indirect symlink in the
    // path and confirm it lives under the bundle root.
    let realPath: string
    try {
      realPath = await realpath(ref.path)
    } catch {
      throw new DurabilityError(`sealEpoch: ref path does not exist: ${ref.path}`)
    }
    const rel = relative(bundleRootAbs, realPath)
    if (rel.startsWith('..') || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new DurabilityError(`sealEpoch: ref path ${ref.path} is outside the bundle root`)
    }
    // CQ-038: kind-specific containment. Each ref kind has an expected
    // location under the bundle root; a CAS pack inside the projection
    // dir (or anywhere else) is refused.
    enforceKindContainment(ref, realPath, handle, bundleRootAbs)
    let st: Awaited<ReturnType<typeof stat>>
    try {
      st = await stat(ref.path)
    } catch {
      throw new DurabilityError(`sealEpoch: ref path does not exist: ${ref.path}`)
    }
    if (st.size !== ref.byteLength) {
      throw new DurabilityError(
        `sealEpoch: ref ${ref.path}: byteLength mismatch (declared ${ref.byteLength}, actual ${st.size})`,
      )
    }
    const bytes = await readFile(ref.path)
    // CQ-031: digest semantics vary by kind. For projection segments the
    // ref.digest IS blake3(bytes) — the segment-writer computes it that
    // way. For CAS / raw-source packs the ref.digest is the
    // self-referential `pack_digest` (placeholder-substitution scheme);
    // we verify that AND blake3(bytes) is what the pack header carries
    // implicitly via verifyCasPack / verifyRawSourcePack.
    switch (ref.kind) {
      case 'cas_object_pack': {
        const v = verifyCasPack(bytes)
        if (v.header.pack_digest !== ref.digest) {
          throw new DurabilityError(
            `sealEpoch: ref ${ref.path}: pack_digest mismatch (declared ${ref.digest}, actual ${v.header.pack_digest})`,
          )
        }
        for (const { entry } of v.entries) out.casObjects.add(entry.object_id)
        break
      }
      case 'raw_source_pack': {
        const v = verifyRawSourcePack(bytes)
        if (v.header.pack_digest !== ref.digest) {
          throw new DurabilityError(
            `sealEpoch: ref ${ref.path}: pack_digest mismatch (declared ${ref.digest}, actual ${v.header.pack_digest})`,
          )
        }
        for (const { entry } of v.entries) {
          out.rawSourceContent.add(entry.content_hash)
          // CQ-037: build the verified inventory keyed by source_file_id.
          if (out.rawSourceInventory.has(entry.source_file_id)) {
            throw new DurabilityError(
              `sealEpoch: raw-source source_file_id ${entry.source_file_id} appears in multiple verified packs`,
            )
          }
          out.rawSourceInventory.set(entry.source_file_id, {
            source_file_id: entry.source_file_id,
            content_hash: entry.content_hash,
            object_id: entry.object_id,
            uncompressed_size: entry.uncompressed_size,
            stored_offset: entry.stored_offset,
            stored_length: entry.stored_length,
            stored_hash: entry.stored_hash,
            compression: entry.compression,
            pack_digest: v.header.pack_digest,
          })
        }
        out.hasRawSourcePack = true
        break
      }
      case 'projection_arrow':
      case 'projection_parquet': {
        if (!ref.entityType) {
          throw new DurabilityError(`sealEpoch: projection ref ${ref.path} has no entityType`)
        }
        const actualDigest = `blake3:${toHex(blake3(bytes))}`
        if (actualDigest !== ref.digest) {
          throw new DurabilityError(
            `sealEpoch: ref ${ref.path}: blake3 mismatch (declared ${ref.digest}, actual ${actualDigest})`,
          )
        }
        await verifyProjectionSegmentMatchesRows(ref, bytes, rowsByEntity[ref.entityType] ?? [])
        out.projectionEntities.add(ref.entityType)
        break
      }
      default: {
        // search_docs_arrow, session_blob_pack, manifest, etc. — for now
        // we only verify byte-digest match. Per-kind content checks land
        // in later lanes.
        const actualDigest = `blake3:${toHex(blake3(bytes))}`
        if (actualDigest !== ref.digest) {
          throw new DurabilityError(
            `sealEpoch: ref ${ref.path}: blake3 mismatch (declared ${ref.digest}, actual ${actualDigest})`,
          )
        }
        break
      }
    }
  }
  return out
}

/**
 * CQ-038: kind-specific containment. Each ref kind has an expected
 * subtree under the bundle root; refs outside that subtree (even if
 * still under the bundle root) are refused so a malicious or buggy
 * writer cannot publish a CAS pack from inside the projection dir, or
 * vice-versa.
 */
function enforceKindContainment(
  ref: DurableSegmentRef,
  realPath: string,
  handle: EpochHandle,
  bundleRootAbs: string,
): void {
  const paths = handle.bundle.paths
  const epochTmpAbs = handle.tmpDir
  const epochPermanentAbs = epochDir(bundleRootAbs, handle.epoch)
  const allowed: string[] = []
  switch (ref.kind) {
    case 'projection_arrow':
    case 'projection_parquet':
      allowed.push(`${epochTmpAbs}${sep}projection`)
      allowed.push(`${epochPermanentAbs}${sep}projection`)
      break
    case 'cas_object_pack':
      allowed.push(paths.casPacks)
      allowed.push(paths.casLarge)
      break
    case 'raw_source_pack':
      allowed.push(paths.rawSourcePacks)
      break
    case 'manifest':
      allowed.push(epochTmpAbs)
      allowed.push(epochPermanentAbs)
      break
    case 'search_docs_arrow':
    case 'session_blob_pack':
      // Lane 1 does not pin a sub-location for these kinds yet; require
      // they live under the bundle root (already enforced above).
      return
  }
  for (const dir of allowed) {
    const rel = relative(dir, realPath)
    if (!rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      return
    }
  }
  throw new DurabilityError(
    `sealEpoch: ref ${ref.path} (kind=${ref.kind}) is not inside any expected location [${allowed.join(', ')}]`,
  )
}

/**
 * Confirm a projection segment file carries exactly the rows being
 * sealed. Recompute what `writeProjectionSegment` would produce from
 * `rows` (using a scratch tmpdir) and compare byte-for-byte.
 */
async function verifyProjectionSegmentMatchesRows(
  ref: DurableSegmentRef,
  fileBytes: Uint8Array,
  rows: readonly Record<string, CborValue>[],
): Promise<void> {
  // Lazy-import to avoid a circular module dependency at load time.
  const { writeProjectionSegment } = await import('../projection/segment-writer.js')
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const scratch = await mkdtemp(`${tmpdir()}/prosa-verify-`)
  try {
    const r = await writeProjectionSegment(ref.entityType as CanonicalEntityType, rows, { outDir: scratch })
    const expected = await readFile(r.ref.path)
    if (expected.length !== fileBytes.length) {
      throw new DurabilityError(
        `sealEpoch: projection segment ${ref.path} length ${fileBytes.length} != expected ${expected.length}`,
      )
    }
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] !== fileBytes[i]) {
        throw new DurabilityError(
          `sealEpoch: projection segment ${ref.path} content does not match in-memory rows for ${ref.entityType}`,
        )
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function sealEpoch(handle: EpochHandle): Promise<SealedEpoch> {
  const rowsByEntity = handle.rowsByEntity()

  const verified = await verifyRegisteredSegments(handle, rowsByEntity)

  for (const [et, m] of Object.entries(rowsByEntity) as [CanonicalEntityType, unknown[]][]) {
    if (m.length === 0) continue
    if (!verified.projectionEntities.has(et)) {
      throw new DurabilityError(
        `sealEpoch: ${et} has ${m.length} rows but no verified projection segment registered (CQ-023)`,
      )
    }
  }
  if (handle.rawSourceEntries().length > 0 && !verified.hasRawSourcePack) {
    throw new DurabilityError('sealEpoch: raw_source entries present but no raw_source_pack registered (CQ-023)')
  }

  validateFkClosure(rowsByEntity, {
    casObjectInventory: verified.casObjects,
    rawSourceInventory: verified.rawSourceContent,
  })

  // CQ-037: enforce raw-source equivalence. Every source_file row must
  // be backed by a verified raw-source pack entry whose key fields
  // (content_hash, object_id, uncompressed_size, stored_*) match, and
  // every verified entry must correspond to either a sealed source_file
  // row or a handle.rawSourceEntries() entry with matching content.
  const sourceRows = (rowsByEntity.source_file ?? []) as Array<Record<string, CborValue>>
  for (const row of sourceRows) {
    const sfid = row.source_file_id as string | undefined
    if (!sfid) continue
    const inv = verified.rawSourceInventory.get(sfid)
    if (!inv) {
      throw new DurabilityError(`sealEpoch: source_file ${sfid} has no verified raw-source pack entry (CQ-037)`)
    }
    // Field name on the canonical source_file row is `size_bytes`;
    // the pack entry surfaces it as `uncompressed_size`.
    const checks: Array<[string, unknown, unknown]> = [
      ['content_hash', row.content_hash, inv.content_hash],
      ['object_id', row.object_id, inv.object_id],
      ['size_bytes', row.size_bytes, inv.uncompressed_size],
      ['pack_digest', row.pack_digest, inv.pack_digest],
      ['stored_offset', row.stored_offset, inv.stored_offset],
      ['stored_length', row.stored_length, inv.stored_length],
      ['compression', row.compression, inv.compression],
    ]
    for (const [field, rowVal, invVal] of checks) {
      if (rowVal !== invVal) {
        throw new DurabilityError(
          `sealEpoch: source_file ${sfid} ${field} mismatch (row=${String(rowVal)}, pack=${String(invVal)}) (CQ-037)`,
        )
      }
    }
  }
  const sourceRowIds = new Set<string>()
  for (const row of sourceRows) {
    const sfid = row.source_file_id as string | undefined
    if (sfid) sourceRowIds.add(sfid)
  }
  for (const handleEntry of handle.rawSourceEntries()) {
    const inv = verified.rawSourceInventory.get(handleEntry.source_file_id)
    if (!inv) {
      throw new DurabilityError(
        `sealEpoch: raw-source entry ${handleEntry.source_file_id} not present in any verified raw-source pack (CQ-037)`,
      )
    }
    if (inv.content_hash !== handleEntry.content_hash) {
      throw new DurabilityError(
        `sealEpoch: raw-source entry ${handleEntry.source_file_id} content_hash mismatch (handle=${handleEntry.content_hash}, pack=${inv.content_hash}) (CQ-037)`,
      )
    }
  }
  for (const sfid of verified.rawSourceInventory.keys()) {
    if (sourceRowIds.size > 0 && !sourceRowIds.has(sfid)) {
      // Allow: verified pack carries an entry that was not staged as a
      // source_file row this epoch *only* if no source_file rows were
      // staged at all (rare, e.g. CAS-only epoch). When source_file
      // rows are present, every verified entry must correspond to one.
      throw new DurabilityError(
        `sealEpoch: raw-source pack entry ${sfid} has no matching source_file row in this epoch (CQ-037)`,
      )
    }
  }

  const counts = handle.computeCounts()
  // CQ-040: counts.objects is the verified CAS inventory size, not the
  // raw-source entry count.
  counts.objects = verified.casObjects.size
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
  // CQ-034: open + write + fsync + close for every published file.
  await writeFileDurable(`${handle.tmpDir}/epoch.manifest.json`, manifestBody)
  await writeFileDurable(
    `${handle.tmpDir}/epoch.manifest.signed.json`,
    new TextEncoder().encode(`${JSON.stringify(signed, null, 2)}\n`),
  )
  // CQ-039: fsync every unique parent directory that owns a registered
  // ref so the directory entry for each pack/segment is durable before
  // we publish the manifest via the epoch-dir rename.
  const refParentDirs = new Set<string>()
  for (const ref of handle.registeredSegments()) {
    refParentDirs.add(dirname(ref.path))
  }
  refParentDirs.add(handle.tmpDir)
  for (const dir of refParentDirs) {
    await syncDir(dir)
  }

  const permanent = epochDir(handle.bundle.paths.root, handle.epoch)
  await mkdir(handle.bundle.paths.epochs, { recursive: true })
  await rename(handle.tmpDir, permanent)
  await syncDir(handle.bundle.paths.epochs)

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
