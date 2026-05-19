// `compact.manifest.cbor` builder — Lane 3 spec deliverable.
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

import { sep } from 'node:path'

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
