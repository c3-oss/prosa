// Compaction GC planner — what is safe to delete RIGHT NOW?
//
// Composes the existing audit primitives:
//
//   - `listSupersededSegmentsFromManifests` → every epoch segment a
//     persisted manifest has recorded as "merged away".
//   - `listCompactedOutputs` → per-compaction-seq consistency
//     between the manifest's claimed output paths and on-disk state.
//
// A superseded segment is SAFE to delete only when its declaring
// compaction-seq is fully consistent (every claimed output exists as
// a real file). If the compaction crashed mid-way (manifest present,
// some outputs missing), removing the sources would lose data — the
// runtime worker may need to re-execute the merge from those
// sources. The planner therefore tags each superseded row with a
// gate: `safe_to_delete: true` (consistent) or `blocked` (the seq
// has an inconsistent output and must finish first).
//
// Pure-read. The planner does not delete anything — that is the
// caller's call. Use case: pipe the plan through `jq` or feed it
// into a separate cleanup step that the user explicitly opts into.

import { listCompactedOutputs } from './outputs.js'
import { type SupersededSegment, listSupersededSegmentsFromManifests } from './superseded.js'

export interface SupersededCleanupCandidate {
  /** Bundle-root-relative path of the superseded source segment.
   *  Same value as the corresponding `superseded[].path` in the
   *  manifest. */
  path: string
  /** Source epoch this segment came from. */
  epoch: number
  /** Stored byte length. */
  byte_length: number
  /** Canonical entity the segment belonged to. */
  entity_type: string
  /** Compaction sequence that superseded this segment. */
  compaction_seq: number
  /** `true` iff the compaction-seq that superseded this segment is
   *  in a consistent post-merge state (every claimed output exists
   *  as a real file). When `false`, GC must NOT delete this
   *  segment because the runtime worker may need to re-execute the
   *  merge. */
  safe_to_delete: boolean
  /** `null` when `safe_to_delete === true`. Otherwise a short
   *  human-readable reason naming the inconsistency
   *  (`output_missing`). */
  blocked_reason: 'output_missing' | null
}

export interface SupersededCleanupPlan {
  /** Every superseded segment, regardless of whether it is safe to
   *  delete. Sorted by `(compaction_seq, entity_type, epoch, path)`
   *  ascending — inherits the order from
   *  `listSupersededSegmentsFromManifests`. */
  candidates: SupersededCleanupCandidate[]
  /** Counts + bytes for the safe-to-delete subset. Convenience
   *  rollup for audit dashboards. */
  safe_to_delete: { count: number; bytes: number }
  /** Counts + bytes for blocked candidates. */
  blocked: { count: number; bytes: number }
}

/**
 * Compose `listSupersededSegmentsFromManifests` +
 * `listCompactedOutputs` into a per-segment GC plan. Each
 * superseded segment carries a `safe_to_delete` flag that is
 * `true` iff its declaring compaction-seq is fully consistent.
 *
 * Empty bundles (no `epochs/`, no persisted manifests) return
 * `{ candidates: [], safe_to_delete: { count: 0, bytes: 0 },
 * blocked: { count: 0, bytes: 0 } }`.
 *
 * The compaction-seq → consistency lookup is built up-front so the
 * walk over superseded segments runs in linear time. A superseded
 * row whose compaction-seq is not present in
 * `listCompactedOutputs` (e.g. the manifest was deleted between
 * the two reads — racy callers only) is treated as blocked; the
 * planner errs on the side of caution.
 */
export async function planSupersededCleanup(bundleRoot: string): Promise<SupersededCleanupPlan> {
  const [superseded, compactedOutputs] = await Promise.all([
    listSupersededSegmentsFromManifests(bundleRoot),
    listCompactedOutputs(bundleRoot),
  ])

  const consistencyBySeq = new Map<number, boolean>()
  for (const row of compactedOutputs) {
    consistencyBySeq.set(row.compaction_seq, row.consistent)
  }

  const candidates: SupersededCleanupCandidate[] = []
  let safeCount = 0
  let safeBytes = 0
  let blockedCount = 0
  let blockedBytes = 0
  for (const segment of superseded) {
    const consistent = consistencyBySeq.get(segment.compaction_seq) ?? false
    const safe = consistent === true
    candidates.push({
      ...toCandidateBase(segment),
      safe_to_delete: safe,
      blocked_reason: safe ? null : 'output_missing',
    })
    if (safe) {
      safeCount += 1
      safeBytes += segment.byte_length
    } else {
      blockedCount += 1
      blockedBytes += segment.byte_length
    }
  }
  return {
    candidates,
    safe_to_delete: { count: safeCount, bytes: safeBytes },
    blocked: { count: blockedCount, bytes: blockedBytes },
  }
}

function toCandidateBase(
  segment: SupersededSegment,
): Pick<SupersededCleanupCandidate, 'path' | 'epoch' | 'byte_length' | 'entity_type' | 'compaction_seq'> {
  return {
    path: segment.path,
    epoch: segment.epoch,
    byte_length: segment.byte_length,
    entity_type: segment.entity_type,
    compaction_seq: segment.compaction_seq,
  }
}
