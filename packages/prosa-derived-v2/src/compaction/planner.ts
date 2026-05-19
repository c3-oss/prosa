// Parquet compaction planner.
//
// Walks `<bundleRoot>/epochs/<n>/projection/` directories, groups the
// `.parquet` segment files per canonical entity name, applies the
// `compactionDecision` policy, and produces a `CompactionPlan` that
// names exactly which segment files would be merged into one
// compacted output per entity type. The plan is the input to the
// future runtime compaction worker, which performs the actual
// row-preserving Parquet merge (deferred to a follow-up iteration).
//
// The planner is deliberately filesystem-driven and does not need to
// parse Parquet rows: the lane-doc compaction policy is content-free
// (file count + byte budget). Plans are also deterministic — given
// the same on-disk layout the planner produces byte-identical output,
// so re-runs across deploys do not invent new compaction work.

import { readdir, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'

import { type CompactionFireReason, type SegmentRef, compactionDecision } from './policy.js'

/** One planned compaction operation, per entity type. */
export interface CompactionEntityPlan {
  /** Canonical entity name parsed from the Parquet filename — e.g.
   *  `sessions`, `messages`, `tool_calls`. */
  entityType: string
  /** The reason the policy decided to fire for this entity. */
  reason: CompactionFireReason
  /** Segments that the runtime worker should merge. Includes
   *  `path`, `byteLength`, and the epoch the segment came from. */
  segmentsToMerge: PlannedSegmentRef[]
  /** Where the merged output should land. Relative to the bundle
   *  root; the runtime worker materialises the byte payload. */
  outputPath: string
  /** Total byte length of segments being merged. */
  totalBytesIn: number
}

export interface PlannedSegmentRef extends SegmentRef {
  /** Numeric epoch the segment lives in. */
  epoch: number
}

export interface CompactionPlan {
  /** One entry per entity type whose policy fired. Entities whose
   *  segments fall under the trigger thresholds are omitted from
   *  the plan. */
  entities: CompactionEntityPlan[]
  /** When `true`, no entity met the policy's fire conditions and the
   *  runtime worker should skip compaction entirely. */
  empty: boolean
}

/** Sequence number used to name compacted outputs. Lane doc reserves
 *  the `compact-<N>` epoch-style directory; the planner picks the
 *  next available `N`. Centralised here so tests can override.
 */
export interface PlanCompactionOptions {
  /** Allow the caller to inject a deterministic `nextCompactionSeq`
   *  function so tests do not depend on the on-disk filesystem state
   *  beyond what the planner explicitly walks. */
  nextCompactionSeq?: (bundleRoot: string) => Promise<number>
}

/**
 * Walk every `epochs/<n>/projection/*.parquet` segment under
 * `bundleRoot` and produce a CompactionPlan. The planner returns an
 * empty plan rather than throwing when no `epochs/` directory exists
 * (a freshly initialised bundle has none).
 */
export async function planCompaction(bundleRoot: string, options: PlanCompactionOptions = {}): Promise<CompactionPlan> {
  const epochsDir = join(bundleRoot, 'epochs')
  const segmentsByEntity = new Map<string, PlannedSegmentRef[]>()

  let epochs: string[] = []
  try {
    epochs = await readdir(epochsDir)
  } catch {
    return { entities: [], empty: true }
  }
  // Only digit-prefixed entries are normal sealed epochs; existing
  // `compact-<N>` directories are skipped so we do not re-compact
  // already-compacted output.
  const numericEpochs = epochs
    .map((name) => ({ name, epoch: Number(name) }))
    .filter((e) => Number.isInteger(e.epoch) && !name_is_compact_dir(e.name))
    .sort((a, b) => a.epoch - b.epoch)

  for (const { name, epoch } of numericEpochs) {
    const projectionDir = join(epochsDir, name, 'projection')
    let entries: string[]
    try {
      entries = await readdir(projectionDir)
    } catch {
      continue
    }
    for (const fileName of entries) {
      if (!fileName.endsWith('.parquet')) continue
      const entityType = fileName.replace(/\.parquet$/, '')
      const relPath = `epochs${sep}${name}${sep}projection${sep}${fileName}`
      const absPath = join(projectionDir, fileName)
      let info: { size: number }
      try {
        info = await stat(absPath)
      } catch {
        continue
      }
      const list = segmentsByEntity.get(entityType) ?? []
      list.push({ path: relPath, byteLength: info.size, epoch })
      segmentsByEntity.set(entityType, list)
    }
  }

  const entities: CompactionEntityPlan[] = []
  const seq = options.nextCompactionSeq
    ? await options.nextCompactionSeq(bundleRoot)
    : await defaultCompactionSeq(epochsDir, epochs)
  for (const [entityType, segments] of Array.from(segmentsByEntity.entries()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const decision = compactionDecision(segments)
    if (!decision.shouldFire || decision.reason === null) continue
    const smallOnly = segments.filter((s) => s.byteLength < 32 * 1024 * 1024).sort((a, b) => a.epoch - b.epoch)
    entities.push({
      entityType,
      reason: decision.reason,
      segmentsToMerge: smallOnly,
      outputPath: `epochs${sep}compact-${String(seq).padStart(4, '0')}${sep}projection${sep}${entityType}.compacted.parquet`,
      totalBytesIn: smallOnly.reduce((sum, s) => sum + s.byteLength, 0),
    })
  }
  return { entities, empty: entities.length === 0 }
}

function name_is_compact_dir(name: string): boolean {
  return name.startsWith('compact-')
}

/**
 * Choose the next compaction sequence number by scanning existing
 * `compact-<NNNN>` directories under `epochs/`. Returns the
 * smallest unused four-digit number; defaults to `1` when none exist.
 */
async function defaultCompactionSeq(epochsDir: string, knownEntries: readonly string[]): Promise<number> {
  let max = 0
  for (const name of knownEntries) {
    const match = /^compact-(\d+)$/.exec(name)
    if (match) {
      const n = Number(match[1])
      if (Number.isInteger(n) && n > max) max = n
    }
  }
  // `epochsDir` is read above; the parameter is kept here for parity
  // with `nextCompactionSeq` should future plans need to read more.
  void epochsDir
  return max + 1
}
