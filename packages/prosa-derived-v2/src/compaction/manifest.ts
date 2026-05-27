// `compact.manifest.cbor` builder + on-disk writer — Lane 3 spec deliverable.
//
// Lane 3 calls for a per-compaction-run manifest that records which
// epoch files were superseded by the merge so audit/GC workflows can
// recover the pre-compaction layout. This module produces the manifest
// from a `CompactionPlan` (planner output) without executing any
// runtime SQL — the runtime worker will eventually write the manifest
// to disk alongside the `compact-<NNNN>/projection/<entity>.compacted.parquet`
// outputs.
//
// The Lane 3 spec calls the file `compact.manifest.cbor`. In line with
// Lane 1's epoch-manifest decision (keep canonical JSON now; reserve
// CBOR for the wire layer), the builder returns a typed TypeScript
// shape rather than CBOR bytes; the encoder/decoder will land in a
// follow-up once a canonical-CBOR helper for free-form objects exists
// in `@c3-oss/prosa-types-v2`. Callers that want to persist the
// manifest today can `JSON.stringify(manifest, null, 2)` it.

import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'

import { syncDir } from '@c3-oss/prosa-bundle-v2'

import { canonicalJsonBytes } from '../session-blob/framing.js'

import type { CompactionEntityPlan, CompactionPlan } from './planner.js'
import type { CompactionFireReason } from './policy.js'

/** Per-entity manifest row. */
export interface CompactManifestEntityV2 {
  /** Canonical entity name (`sessions`, `messages`, ...). */
  entity_type: string
  /** Reason the planner fired for this entity (mirrors the
   *  `CompactionEntityPlan.reason` enum). */
  reason: CompactionFireReason
  /** Bundle-root-relative path the compacted Parquet file will be
   *  written to (e.g. `epochs/compact-0001/projection/sessions.compacted.parquet`). */
  output_path: string
  /** Total bytes across all superseded segments. */
  total_bytes_in: number
  /** Segments the runtime worker will merge into `output_path`.
   *  Each row is the bundle-root-relative path of the original
   *  segment plus its byte length and source epoch. After the merge
   *  lands these segments are eligible for GC. */
  superseded: Array<{
    epoch: number
    path: string
    byte_length: number
  }>
}

/** Top-level `compact.manifest.cbor` shape. */
export interface CompactManifestV2 {
  /** Schema discriminator. */
  schema: 'prosa.compact-manifest.v2'
  /** The `compact-<NNNN>` sequence number this manifest belongs to.
   *  Extracted from the entity output paths; throws when entities
   *  disagree (planner invariant — every entity in a single plan
   *  shares one seq). */
  compaction_seq: number
  /** Caller-supplied ISO-8601 UTC timestamp marking when the
   *  manifest was generated. Use the runtime worker's wall-clock
   *  time, not the planner's. */
  generated_at: string
  /** One row per entity whose policy fired. */
  entities: CompactManifestEntityV2[]
}

export interface BuildCompactManifestInput {
  plan: CompactionPlan
  /** ISO-8601 UTC string. Caller supplies this so the manifest is
   *  deterministic across reruns when the inputs are equal. */
  generatedAt: string
}

const COMPACT_SEQ_PATTERN = /(?:^|[\\/])compact-(\d+)(?:[\\/]|$)/

/**
 * Build a `CompactManifestV2` from a `CompactionPlan` + caller-supplied
 * generation timestamp. The planner already names the compacted
 * output path with the `compact-<NNNN>` sequence, so the builder
 * derives `compaction_seq` from it (verifying every entity agrees).
 *
 * Pure function — no filesystem, no clock. Throws when:
 *
 *   - the plan is empty (`plan.empty === true`) — callers should not
 *     persist a manifest for a non-fire plan;
 *   - the entity output paths disagree on the sequence number;
 *   - any output path lacks a `compact-<NNNN>` segment.
 */
export function buildCompactManifestV2(input: BuildCompactManifestInput): CompactManifestV2 {
  if (input.plan.empty || input.plan.entities.length === 0) {
    throw new Error('buildCompactManifestV2: refusing to build a manifest for an empty plan')
  }
  const seqs = new Set<number>()
  const entities: CompactManifestEntityV2[] = []
  for (const entity of input.plan.entities) {
    const seq = extractCompactionSeq(entity)
    seqs.add(seq)
    entities.push({
      entity_type: entity.entityType,
      reason: entity.reason,
      output_path: entity.outputPath,
      total_bytes_in: entity.totalBytesIn,
      superseded: entity.segmentsToMerge.map((segment) => ({
        epoch: segment.epoch,
        path: segment.path,
        byte_length: segment.byteLength,
      })),
    })
  }
  if (seqs.size > 1) {
    throw new Error(
      `buildCompactManifestV2: plan entities disagree on compaction sequence (${[...seqs].sort().join(', ')})`,
    )
  }
  return {
    schema: 'prosa.compact-manifest.v2',
    compaction_seq: [...seqs][0]!,
    generated_at: input.generatedAt,
    entities,
  }
}

function extractCompactionSeq(entity: CompactionEntityPlan): number {
  // The planner emits the output path with the platform separator. We
  // accept either `/` or `\` so the helper works on both Windows and
  // POSIX (matches the planner's `sep` usage on line 128 of planner.ts).
  const match = COMPACT_SEQ_PATTERN.exec(entity.outputPath)
  if (!match) {
    throw new Error(
      `buildCompactManifestV2: entity ${entity.entityType} outputPath ${entity.outputPath} does not contain a compact-<NNNN> segment (sep=${JSON.stringify(sep)})`,
    )
  }
  const seq = Number(match[1])
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(
      `buildCompactManifestV2: entity ${entity.entityType} outputPath ${entity.outputPath} has non-integer compaction seq ${match[1]}`,
    )
  }
  return seq
}

/**
 * Canonical on-disk path of the compact manifest for a given
 * compaction sequence. Format:
 * `<bundleRoot>/epochs/compact-<NNNN>/compact.manifest.json`.
 *
 * The Lane 3 spec calls the file `.cbor`; in line with Lane 1's
 * epoch-manifest decision (`epoch.manifest.json` today; rename to
 * `.cbor` when a canonical-CBOR encoder for free-form maps lands
 * in `@c3-oss/prosa-types-v2`), this writer + reader use the
 * `.json` extension. Callers that want to round-trip the manifest
 * across implementations should consume `readCompactManifestV2`
 * and `writeCompactManifestV2` rather than hand-rolling paths.
 */
export function compactManifestPath(bundleRoot: string, compactionSeq: number): string {
  if (!Number.isInteger(compactionSeq) || compactionSeq < 0) {
    throw new Error(`compactManifestPath: invalid compaction_seq ${compactionSeq} (expected non-negative integer)`)
  }
  return join(bundleRoot, 'epochs', `compact-${String(compactionSeq).padStart(4, '0')}`, 'compact.manifest.json')
}

/**
 * Persist a `CompactManifestV2` to disk using the same
 * atomic-rename + parent-fsync pattern as `writeIndexCheckpoint`
 * (CQ-093). The bytes are canonical-JSON-encoded so the same
 * manifest always produces the same on-disk bytes — the runtime
 * worker can compute the manifest digest deterministically.
 *
 * Containment guards (parallel to CQ-094 / CQ-098 / CQ-103):
 *
 *   - Refuses to write when `<bundleRoot>/epochs` or
 *     `<bundleRoot>/epochs/compact-<NNNN>` is a symlink — the
 *     manifest is bundle-internal state and must not be staged
 *     into an external tree.
 *   - Refuses when the final `compact.manifest.json` already
 *     exists as a symlink (rather than a regular file) — same
 *     reasoning.
 *   - Creates the `epochs/compact-<NNNN>/` directory if needed.
 *     The runtime worker (which lands separately) will also
 *     create the projection subdirectory; this writer's
 *     responsibility ends at the manifest itself.
 *
 * Returns the resolved path so callers can chain
 * `readCompactManifestV2` for round-trip verification.
 */
export async function writeCompactManifestV2(bundleRoot: string, manifest: CompactManifestV2): Promise<string> {
  const path = compactManifestPath(bundleRoot, manifest.compaction_seq)
  const dir = dirname(path)
  await refuseSymlinkedIntermediate(bundleRoot, manifest.compaction_seq)
  await refuseSymlinkedFinal(path)

  const bytes = canonicalJsonBytes(manifestToCanonicalShape(manifest))
  const tmp = `${path}.tmp.${process.pid}.${randomSuffix()}`
  await mkdir(dir, { recursive: true })
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tmp, path)
  } catch (err) {
    try {
      await unlink(tmp)
    } catch {
      // ignore
    }
    throw err
  }
  await syncDir(dir)
  return path
}

/**
 * Read the persisted manifest back from disk. Throws when the
 * file is missing (callers should know whether a compaction ran),
 * when the bytes do not parse as JSON, when the parsed shape is
 * not the expected manifest, or when the containment guards
 * (`refuseSymlinkedIntermediate` / final symlink) trip.
 */
export async function readCompactManifestV2(bundleRoot: string, compactionSeq: number): Promise<CompactManifestV2> {
  const path = compactManifestPath(bundleRoot, compactionSeq)
  await refuseSymlinkedIntermediate(bundleRoot, compactionSeq)
  await refuseSymlinkedFinal(path)
  const bytes = await readFile(path)
  const text = bytes.toString('utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`readCompactManifestV2: ${path} is not valid JSON: ${message}`)
  }
  const manifest = assertManifestShape(parsed, path)
  // CQ-107: the persisted compaction_seq must match the requested
  // one. A drift here means the caller is reading a manifest other
  // than the one indexed by `compactionSeq` — almost always a bug.
  if (manifest.compaction_seq !== compactionSeq) {
    throw new Error(
      `readCompactManifestV2: ${path} has compaction_seq ${manifest.compaction_seq}, expected ${compactionSeq}`,
    )
  }
  return manifest
}

function manifestToCanonicalShape(m: CompactManifestV2): Record<string, unknown> {
  return {
    compaction_seq: m.compaction_seq,
    entities: m.entities.map((e) => ({
      entity_type: e.entity_type,
      output_path: e.output_path,
      reason: e.reason,
      superseded: e.superseded.map((s) => ({
        byte_length: s.byte_length,
        epoch: s.epoch,
        path: s.path,
      })),
      total_bytes_in: e.total_bytes_in,
    })),
    generated_at: m.generated_at,
    schema: m.schema,
  }
}

const VALID_REASONS: ReadonlySet<CompactionFireReason> = new Set(['file_count_trigger', 'low_count_byte_ceiling'])

/**
 * CQ-109: reject any path that is not a safe bundle-relative path.
 * Audit/GC code joins persisted `entity.output_path` and every
 * `superseded[].path` against `bundleRoot` before stat/read/eventual-
 * delete. A corrupted or third-party manifest with an absolute path
 * (`/etc/passwd`, `C:\Users\...`) or a `..` traversal segment would
 * steer those helpers outside the bundle. Only paths composed of
 * `/`- or `\`-separated non-`..` segments are accepted.
 */
function isBundleRelativeSafePath(value: string): boolean {
  if (value.startsWith('/')) return false
  if (value.startsWith('\\')) return false
  if (/^[A-Za-z]:[\\/]/.test(value)) return false
  for (const segment of value.split(/[\\/]/)) {
    if (segment === '..') return false
  }
  return true
}

function assertManifestShape(value: unknown, path: string): CompactManifestV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`readCompactManifestV2: ${path} is not a JSON object`)
  }
  const obj = value as Record<string, unknown>
  if (obj.schema !== 'prosa.compact-manifest.v2') {
    throw new Error(`readCompactManifestV2: ${path} has unexpected schema ${JSON.stringify(obj.schema)}`)
  }
  if (typeof obj.compaction_seq !== 'number' || !Number.isInteger(obj.compaction_seq) || obj.compaction_seq < 0) {
    throw new Error(`readCompactManifestV2: ${path} has invalid compaction_seq ${JSON.stringify(obj.compaction_seq)}`)
  }
  if (typeof obj.generated_at !== 'string') {
    throw new Error(`readCompactManifestV2: ${path} has non-string generated_at`)
  }
  if (!Array.isArray(obj.entities)) {
    throw new Error(`readCompactManifestV2: ${path} has non-array entities`)
  }
  // CQ-107: validate every entity + every superseded segment before
  // returning. The reader is the persisted-format boundary for audit /
  // GC recovery, so a corrupted, partially-written, or third-party
  // manifest must surface as a clear error, not flow into downstream
  // code as a malformed structure.
  const entities: CompactManifestEntityV2[] = []
  for (let i = 0; i < obj.entities.length; i++) {
    entities.push(assertEntityShape(obj.entities[i], path, i))
  }
  return {
    schema: 'prosa.compact-manifest.v2',
    compaction_seq: obj.compaction_seq,
    generated_at: obj.generated_at,
    entities,
  }
}

function assertEntityShape(value: unknown, path: string, index: number): CompactManifestEntityV2 {
  const where = `entities[${index}]`
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`readCompactManifestV2: ${path} ${where} is not a JSON object`)
  }
  const obj = value as Record<string, unknown>
  if (typeof obj.entity_type !== 'string' || obj.entity_type.length === 0) {
    throw new Error(`readCompactManifestV2: ${path} ${where}.entity_type is not a non-empty string`)
  }
  if (typeof obj.reason !== 'string' || !VALID_REASONS.has(obj.reason as CompactionFireReason)) {
    throw new Error(
      `readCompactManifestV2: ${path} ${where}.reason ${JSON.stringify(obj.reason)} is not one of: ${[...VALID_REASONS].join(', ')}`,
    )
  }
  if (typeof obj.output_path !== 'string' || obj.output_path.length === 0) {
    throw new Error(`readCompactManifestV2: ${path} ${where}.output_path is not a non-empty string`)
  }
  if (!isBundleRelativeSafePath(obj.output_path)) {
    throw new Error(
      `readCompactManifestV2: ${path} ${where}.output_path ${JSON.stringify(obj.output_path)} is not a bundle-relative path without traversal (CQ-109)`,
    )
  }
  if (typeof obj.total_bytes_in !== 'number' || !Number.isInteger(obj.total_bytes_in) || obj.total_bytes_in < 0) {
    throw new Error(
      `readCompactManifestV2: ${path} ${where}.total_bytes_in ${JSON.stringify(obj.total_bytes_in)} is not a non-negative integer`,
    )
  }
  if (!Array.isArray(obj.superseded)) {
    throw new Error(`readCompactManifestV2: ${path} ${where}.superseded is not an array`)
  }
  const superseded: CompactManifestEntityV2['superseded'] = []
  for (let j = 0; j < obj.superseded.length; j++) {
    superseded.push(assertSupersededShape(obj.superseded[j], path, `${where}.superseded[${j}]`))
  }
  return {
    entity_type: obj.entity_type,
    reason: obj.reason as CompactionFireReason,
    output_path: obj.output_path,
    total_bytes_in: obj.total_bytes_in,
    superseded,
  }
}

function assertSupersededShape(
  value: unknown,
  path: string,
  where: string,
): CompactManifestEntityV2['superseded'][number] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`readCompactManifestV2: ${path} ${where} is not a JSON object`)
  }
  const obj = value as Record<string, unknown>
  if (typeof obj.epoch !== 'number' || !Number.isInteger(obj.epoch) || obj.epoch < 0) {
    throw new Error(
      `readCompactManifestV2: ${path} ${where}.epoch ${JSON.stringify(obj.epoch)} is not a non-negative integer`,
    )
  }
  if (typeof obj.path !== 'string' || obj.path.length === 0) {
    throw new Error(`readCompactManifestV2: ${path} ${where}.path is not a non-empty string`)
  }
  if (!isBundleRelativeSafePath(obj.path)) {
    throw new Error(
      `readCompactManifestV2: ${path} ${where}.path ${JSON.stringify(obj.path)} is not a bundle-relative path without traversal (CQ-109)`,
    )
  }
  if (typeof obj.byte_length !== 'number' || !Number.isInteger(obj.byte_length) || obj.byte_length < 0) {
    throw new Error(
      `readCompactManifestV2: ${path} ${where}.byte_length ${JSON.stringify(obj.byte_length)} is not a non-negative integer`,
    )
  }
  return { epoch: obj.epoch, path: obj.path, byte_length: obj.byte_length }
}

async function refuseSymlinkedIntermediate(bundleRoot: string, compactionSeq: number): Promise<void> {
  const epochsDir = join(bundleRoot, 'epochs')
  await refuseSymlinkAt(epochsDir, 'epochs')
  const compactDir = join(epochsDir, `compact-${String(compactionSeq).padStart(4, '0')}`)
  await refuseSymlinkAt(compactDir, `epochs/compact-${String(compactionSeq).padStart(4, '0')}`)
}

async function refuseSymlinkAt(path: string, label: string): Promise<void> {
  try {
    const st = await lstat(path)
    if (st.isSymbolicLink()) {
      throw new Error(
        `compact manifest: refusing to use ${label} — ${path} is a symlink. Resolve the symlink configuration manually before retrying.`,
      )
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return
    throw err
  }
}

async function refuseSymlinkedFinal(path: string): Promise<void> {
  try {
    const st = await lstat(path)
    if (st.isSymbolicLink()) {
      throw new Error(
        `compact manifest: refusing to read/write ${path} — final path is a symlink. Resolve the symlink configuration manually before retrying.`,
      )
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return
    throw err
  }
}

function randomSuffix(): string {
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0')
}
