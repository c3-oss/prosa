// Compaction overlap detection — same source segment claimed by
// multiple persisted manifests.
//
// Invariant: each source segment can be superseded by AT MOST one
// compaction. If two persisted manifests both list the same
// bundle-relative path in their `superseded[]`, something has
// gone wrong upstream — most plausibly:
//
//   - the runtime GC step crashed before deleting superseded
//     sources after compaction N, and then compaction N+1 picked
//     up the same files because the planner re-read them from
//     `listProjectionSegments`;
//   - or a hand-edited / mistakenly-restored manifest now
//     references segments another manifest already claimed.
//
// Both are bugs. The downstream GC planner already gates on
// per-compaction-seq consistency, but it cannot detect cross-seq
// overlaps because it processes one seq at a time. This module
// closes that gap: walk every persisted manifest's superseded
// array, group by path, and flag any path that appears in more
// than one manifest.
//
// Pure-read. Composes `listSupersededSegmentsFromManifests` and
// performs the grouping in memory. Result is sorted by `path`
// ascending for deterministic audit reports.

import { listSupersededSegmentsFromManifests } from './superseded.js'

export interface CompactionOverlapRow {
  /** Bundle-relative path of the source segment claimed by more
   *  than one compaction. */
  path: string
  /** Every compaction-seq + entity-type pair that claims this
   *  path. Sorted by `compaction_seq` ascending. Length is always
   *  >= 2 (single-claim rows are filtered out). */
  claimed_by: Array<{ compaction_seq: number; entity_type: string }>
}

/**
 * Walk every persisted manifest's superseded array and return the
 * subset of source paths claimed by more than one compaction.
 *
 * The healthy case returns `[]`. Any non-empty result is a real
 * correctness violation — operators should resolve the duplicate
 * claim before running GC.
 *
 * Sorted by `path` ascending so audit reports are deterministic.
 */
export async function detectCompactionOverlaps(bundleRoot: string): Promise<CompactionOverlapRow[]> {
  const segments = await listSupersededSegmentsFromManifests(bundleRoot)
  const byPath = new Map<string, Array<{ compaction_seq: number; entity_type: string }>>()
  for (const segment of segments) {
    const existing = byPath.get(segment.path)
    const entry = { compaction_seq: segment.compaction_seq, entity_type: segment.entity_type }
    if (existing === undefined) {
      byPath.set(segment.path, [entry])
    } else {
      existing.push(entry)
    }
  }

  const overlaps: CompactionOverlapRow[] = []
  for (const [path, claimed_by] of byPath) {
    if (claimed_by.length < 2) continue
    claimed_by.sort((a, b) => a.compaction_seq - b.compaction_seq)
    overlaps.push({ path, claimed_by })
  }
  overlaps.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return overlaps
}
