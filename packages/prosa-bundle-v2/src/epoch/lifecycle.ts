// Epoch lifecycle: beginEpoch / sealEpoch / FK-closure validation.
//
// An epoch is the atomic unit of bundle progression. While open, all
// writes go to `tmp/epoch-N/`. Sealing validates foreign-key closure
// across canonical entity rows, computes `bundleRoot` and `rawSourceRoot`,
// writes the canonical manifest, atomically renames `tmp/epoch-N/` →
// `epochs/N/`, and then atomically rewrites `head.json` to point at N.

import { mkdir, rename, writeFile } from 'node:fs/promises'

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
          // counts.projects is intentionally omitted from BundleCountsV2;
          // projects live in the projectionRows total below.
          break
      }
    }
    // projectionRows = sum of all entity rows.
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

const FK_RULES: Array<{
  child: CanonicalEntityType
  field: string
  parent: CanonicalEntityType
}> = [
  { child: 'turn', field: 'session_id', parent: 'session' },
  { child: 'event', field: 'session_id', parent: 'session' },
  { child: 'message', field: 'session_id', parent: 'session' },
  { child: 'content_block', field: 'session_id', parent: 'session' },
  { child: 'tool_call', field: 'session_id', parent: 'session' },
  { child: 'tool_result', field: 'session_id', parent: 'session' },
]

/**
 * Verify that every cross-entity reference points at an existing row.
 * Only a handful of high-value links are checked here (those that the
 * lane doc calls out by name); additional rules can be added as Lane 2
 * importers expose them.
 */
export function validateFkClosure(rowsByEntity: Record<CanonicalEntityType, Record<string, CborValue>[]>): void {
  const ids: Partial<Record<CanonicalEntityType, Set<string>>> = {}
  for (const [et, rows] of Object.entries(rowsByEntity) as [CanonicalEntityType, Record<string, CborValue>[]][]) {
    const s = new Set<string>()
    for (const row of rows) {
      const pkField = pkFieldFor(et)
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

export async function beginEpoch(bundle: Bundle, options: BeginEpochOptions = {}): Promise<EpochHandle> {
  const next = bundle.head.epoch + 1
  const tmp = epochTmpDir(bundle.paths.root, next)
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
 * Validate FK closure, compute roots, write the manifest, atomically
 * rename `tmp/epoch-N/` → `epochs/N/`, then atomically swap `head.json`.
 */
export async function sealEpoch(handle: EpochHandle): Promise<SealedEpoch> {
  const rowsByEntity = handle.rowsByEntity()
  validateFkClosure(rowsByEntity)

  const bundleRoot = toHex(bundleRootFromRows(rowsByEntity))
  const rawSourceRoot = toHex(rawSourceRootFromEntries(handle.rawSourceEntries()))
  const counts = handle.computeCounts()

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
    segments: [],
    counts,
  }
  const signed: SignedEpochManifestV2 = { manifest, signature: { ...PLACEHOLDER_SIGNATURE } }

  // Manifest bytes are canonical JSON via epochManifestBytes; we persist
  // both the signed envelope (with placeholder signature) and the
  // bytes-actually-signed for future verification.
  const manifestBody = epochManifestBytes(manifest)
  const manifestPath = `${handle.tmpDir}/epoch.manifest.json`
  await writeFile(manifestPath, manifestBody)
  const signedPath = `${handle.tmpDir}/epoch.manifest.signed.json`
  await writeFile(signedPath, `${JSON.stringify(signed, null, 2)}\n`)

  // Atomic rename tmp → epochs/N/.
  const permanent = epochDir(handle.bundle.paths.root, handle.epoch)
  await mkdir(handle.bundle.paths.epochs, { recursive: true })
  await rename(handle.tmpDir, permanent)

  // Compute new manifestDigest for head.json (the per-store local content
  // address of the just-rendered manifest bytes).
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
    segments: [],
  }
  await handle.bundle.swapHead(nextHead)

  return { epoch: handle.epoch, manifest: signed, head: nextHead, permanentDir: permanent }
}
