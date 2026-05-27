// GC execution plan — the safe-to-delete unlink-step sequence.
//
// `planSupersededCleanup` is the descriptive layer: every
// superseded segment, classified as `safe_to_delete` or blocked.
// `planGcExecution` is the execution-side counterpart: filter to
// the safe subset, emit one step per row, deterministic order,
// totals for the operator dashboard. The runtime GC executor — once
// it lands behind a future filesystem-mutation gate — iterates this
// list and calls `unlink` per step. Until then this plan is a
// dry-run / audit surface only.
//
// Pure-read: no `unlink`, no `rm`, no filesystem mutation. The
// planner only inspects the cleanup plan it is given. This mirrors
// `planCompactionExecution`: the planner shape is stable now and
// the runtime executor binds to it later.

import { type SupersededCleanupPlan, planSupersededCleanup } from './gc-plan.js'

export interface GcExecutionStep {
  /** Bundle-root-relative path of the superseded source segment.
   *  Same value as the corresponding `superseded[].path` in the
   *  declaring manifest. */
  path: string
  /** Stored byte length of the segment. */
  byte_length: number
  /** Source epoch the segment came from. */
  epoch: number
  /** Canonical entity the segment belonged to. */
  entity_type: string
  /** Compaction sequence that superseded this segment. The runtime
   *  executor uses this to group its work per declaring manifest
   *  and to attribute the reclaim in audit logs. */
  compaction_seq: number
}

export interface GcExecutionPlan {
  /** `true` iff `steps` is empty (no safe-to-delete candidates). */
  empty: boolean
  /** Total bytes reclaimed if every step succeeds. */
  total_bytes: number
  /** Deterministic ordered list of unlink steps. Sorted by
   *  `(compaction_seq, entity_type, epoch, path)` ascending —
   *  inherits the order from `planSupersededCleanup`'s candidate
   *  list, which itself inherits from
   *  `listSupersededSegmentsFromManifests`. */
  steps: GcExecutionStep[]
}

/**
 * Compose a {@link SupersededCleanupPlan} into a deterministic
 * ordered unlink-step plan. Blocked rows are dropped — only
 * `safe_to_delete: true` candidates enter the execution plan.
 *
 * The two-argument shape lets callers either pass an already-
 * computed plan (cheap, reused across multiple consumers) or
 * resolve from a bundle root (one-shot CLI use). When given a
 * store root, this function calls `planSupersededCleanup` under
 * the hood.
 *
 * Empty inputs (`{ candidates: [], ... }`) return `{ empty: true,
 * total_bytes: 0, steps: [] }`.
 */
export async function planGcExecution(input: SupersededCleanupPlan | string): Promise<GcExecutionPlan> {
  const plan = typeof input === 'string' ? await planSupersededCleanup(input) : input

  const steps: GcExecutionStep[] = []
  let totalBytes = 0
  for (const candidate of plan.candidates) {
    if (!candidate.safe_to_delete) continue
    steps.push({
      path: candidate.path,
      byte_length: candidate.byte_length,
      epoch: candidate.epoch,
      entity_type: candidate.entity_type,
      compaction_seq: candidate.compaction_seq,
    })
    totalBytes += candidate.byte_length
  }

  return {
    empty: steps.length === 0,
    total_bytes: totalBytes,
    steps,
  }
}
