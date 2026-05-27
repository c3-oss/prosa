// Bundle-aware Tantivy rebuild orchestrator.
//
// `runTantivyRebuild` (in `./runtime-writer.ts`) is row-source-agnostic
// — the caller passes a `loadRows(plan)` producer. The CLI surface
// always wants the same producer: read the `search_doc` projection
// segment for the bundle's current epoch. This module wraps that path
// so callers (`prosa index-v2 tantivy`, the MCP runtime tool, future
// scripted gates) do not each re-derive the segment path, parse
// NDJSON, and map fields.
//
// The orchestrator is intentionally narrow: it resolves a single
// epoch (the latest, unless overridden), reads the segment once, and
// hands the materialised rows to the runtime writer through the
// plan-aware filter. The "stream rows lazily" optimisation is out of
// scope here — a real prosa store has at most a few hundred thousand
// search_docs per epoch, well within node's memory budget.

import { readSearchDocSegment } from './projection-reader.js'
import type { RebuildPlan } from './rebuild-plan.js'
import { type RunTantivyRebuildInput, type RuntimeResult, runTantivyRebuild } from './runtime-writer.js'

export interface RunTantivyRebuildForBundleInput {
  /** Absolute bundle root (matches the planner / runtime writer). */
  bundleRoot: string
  /** Epoch to source `search_doc` rows from. Required — the bundle's
   *  current epoch comes from `head.json`, which this package does
   *  not depend on; the caller (CLI / MCP / test harness) passes it
   *  in after reading the head. */
  epoch: number
  /** Caller flag forwarded to the planner (`prosa index-v2 tantivy --overwrite`). */
  overwriteRequested?: boolean
  /** Native writer heap tuning; defaults match the runtime writer
   *  (300 MiB / 4 threads). */
  heapBytes?: RunTantivyRebuildInput['heapBytes']
  numThreads?: RunTantivyRebuildInput['numThreads']
}

/** Outcome that includes whether a segment was found alongside the
 *  inner runtime result. The CLI uses this to differentiate "bundle
 *  has no search_docs in this epoch" (the segment is missing entirely)
 *  from "the planner skipped". */
export type RebuildForBundleResult =
  /** `<bundleRoot>/epochs/<epoch>/projection/search_doc.prosa-projection.ndjson`
   *  does not exist. No native writer is opened. The Tantivy
   *  checkpoint is left untouched — the bundle has no docs to index. */
  | { kind: 'no_search_docs'; epoch: number; segmentPath: string }
  /** Reader resolved rows; the runtime writer's result is forwarded
   *  verbatim. The orchestrator does not synthesise additional fields. */
  | { kind: 'ran'; epoch: number; segmentPath: string; sourceDocCount: number; result: RuntimeResult }

/**
 * Resolve the `search_doc` projection segment for `epoch`, read its
 * rows, and drive `runTantivyRebuild` against them. The orchestrator
 * fans the planner's `incremental` mode to `rowid > lastIndexedRowid`
 * filtering against the synthetic rowids assigned by the reader; the
 * `full` mode replays the whole segment.
 *
 * Returns `{ kind: 'no_search_docs' }` when the segment file is
 * absent — the bundle simply has nothing to index in this epoch.
 */
export async function runTantivyRebuildForBundle(
  input: RunTantivyRebuildForBundleInput,
): Promise<RebuildForBundleResult> {
  const segment = await readSearchDocSegment(input.bundleRoot, input.epoch)
  if (segment === null) {
    return {
      kind: 'no_search_docs',
      epoch: input.epoch,
      segmentPath: `${input.bundleRoot}/epochs/${input.epoch}/projection/search_doc.prosa-projection.ndjson`,
    }
  }
  const result = await runTantivyRebuild({
    bundleRoot: input.bundleRoot,
    currentMaxRowid: segment.maxRowid,
    sourceDocCount: segment.sourceDocCount,
    currentEpoch: input.epoch,
    overwriteRequested: input.overwriteRequested,
    heapBytes: input.heapBytes,
    numThreads: input.numThreads,
    loadRows: (plan: RebuildPlan) => {
      if (plan.kind === 'incremental') {
        return segment.rows.filter((row) => row.rowid > plan.lastIndexedRowid)
      }
      if (plan.kind === 'full') {
        return segment.rows
      }
      return []
    },
  })
  return {
    kind: 'ran',
    epoch: input.epoch,
    segmentPath: segment.segmentPath,
    sourceDocCount: segment.sourceDocCount,
    result,
  }
}
