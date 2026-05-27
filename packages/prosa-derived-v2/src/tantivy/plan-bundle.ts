// Bundle-aware Tantivy rebuild orchestration.
//
// `planTantivyRebuild` (in `./rebuild-plan.ts`) is pure: caller hands
// it a checkpoint + max rowid + an `indexDirValid` boolean. Two of
// those inputs come from `<bundleRoot>/derived/tantivy/` filesystem
// state, so every caller has to make the same two reads before
// invoking the planner. This module collapses that boilerplate into
// one async helper.
//
// The helper does NOT execute the rebuild plan — it returns the plan
// + the checkpoint it read + the probe boolean so the caller can keep
// using the same values for follow-up writes (e.g.
// `checkpointAfterRebuild` / `checkpointAfterFailure`).

import { readIndexCheckpointOrEmpty } from './checkpoint-store.js'
import { tantivyIndexDirIsValid } from './index-dir.js'
import { type IndexCheckpointV2, type RebuildPlan, planTantivyRebuild } from './rebuild-plan.js'

export interface PlanTantivyRebuildFromBundleInput {
  /** Absolute bundle root. Used to locate
   *  `derived/tantivy/checkpoint.json` and `derived/tantivy/index`. */
  bundleRoot: string
  /** Highest `rowid` in the current `search_docs` projection. The
   *  bundle-v2 layer derives this from the projection rebuild;
   *  passing 0 is valid for an empty bundle and forces a `full`
   *  rebuild via `no_prior_index`. */
  currentMaxRowid: number
  /** Current bundle epoch the caller is sourcing rows from. When
   *  provided, the planner forces `full / epoch_mismatch` if the
   *  stored checkpoint's `last_indexed_epoch` differs (CQ-115). */
  currentEpoch?: number
  /** Caller-supplied flag (`prosa index-v2 tantivy --overwrite`). */
  overwriteRequested?: boolean
}

export interface PlanTantivyRebuildFromBundleResult {
  /** The plan the runtime writer applies. */
  plan: RebuildPlan
  /** Checkpoint actually read from disk (or
   *  `EMPTY_INDEX_CHECKPOINT` when no prior checkpoint existed).
   *  Exposed so callers can compose follow-up state updates
   *  (`checkpointAfterRebuild` / `checkpointAfterFailure`) without
   *  re-reading the file. */
  checkpoint: IndexCheckpointV2
  /** Result of the `<bundleRoot>/derived/tantivy/index` probe. */
  indexDirValid: boolean
}

/**
 * Read the on-disk checkpoint, probe the index directory, and feed
 * both into `planTantivyRebuild`. Returns the plan plus the
 * checkpoint and probe boolean so callers can chain
 * `checkpointAfterRebuild` / `checkpointAfterFailure` without
 * re-reading state.
 *
 * No side effects: this helper only reads files. The actual rebuild
 * (Tantivy native writer) and post-run checkpoint write
 * (`writeIndexCheckpoint`) remain the caller's responsibility.
 *
 * Inherits validation from the underlying calls: a malformed
 * `checkpoint.json` throws (from `readIndexCheckpointOrEmpty`); a
 * missing or symlinked `derived/tantivy/index` resolves to
 * `indexDirValid: false` (from `tantivyIndexDirIsValid`), and the
 * planner reacts with `full` / `no_prior_index` or
 * `index_dir_invalid`.
 */
export async function planTantivyRebuildFromBundle(
  input: PlanTantivyRebuildFromBundleInput,
): Promise<PlanTantivyRebuildFromBundleResult> {
  const [checkpoint, indexDirValid] = await Promise.all([
    readIndexCheckpointOrEmpty(input.bundleRoot),
    tantivyIndexDirIsValid(input.bundleRoot),
  ])
  const plan = planTantivyRebuild({
    checkpoint,
    currentMaxRowid: input.currentMaxRowid,
    indexDirValid,
    overwriteRequested: input.overwriteRequested,
    currentEpoch: input.currentEpoch,
  })
  return { plan, checkpoint, indexDirValid }
}
