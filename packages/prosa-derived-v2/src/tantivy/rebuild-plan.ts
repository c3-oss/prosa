// Tantivy rebuild planner.
//
// Decides — purely from the stored index status + the current
// schema fingerprint + the projection's max `search_docs.rowid` —
// whether the next Tantivy run should be a full rebuild, an
// incremental append, or skip. The runtime writer consumes the
// resulting `RebuildPlan` and does not re-derive the decision.

import { currentTantivySchemaFingerprint } from './schema.js'

/** Stored Tantivy index checkpoint, persisted alongside the bundle.
 *  Mirrors v1's `search_index_status` row for the `tantivy` engine. */
export interface IndexCheckpointV2 {
  /** Highest `search_docs.rowid` present in the Tantivy index. */
  last_indexed_rowid: number | null
  /** Bundle epoch the prior run sourced rows from. The v2 projection
   *  is a per-epoch snapshot — `rowid` is a synthetic position-based
   *  watermark inside one segment and is not comparable across
   *  epochs. Storing the epoch lets `planTantivyRebuild` detect an
   *  epoch change and force `full / epoch_mismatch` rather than
   *  routing to `skip` or `incremental` against rowids from a
   *  different snapshot (CQ-115). `null` for legacy checkpoints
   *  written before the field landed; the planner treats `null` the
   *  same as a mismatch and forces `full`. */
  last_indexed_epoch: number | null
  /** Schema fingerprint stored at last successful indexing. */
  schema_fingerprint: string | null
  /** Reported status of the last run. */
  status: 'idle' | 'building' | 'ready' | 'failed' | null
  /** Stored count from the last run; used for `prosa index-v2 status` UI. */
  indexed_doc_count: number | null
  /** Last observed `count(*)` from the search_docs projection. */
  source_doc_count: number | null
  /** Last error message, if `status === 'failed'`. */
  error_message: string | null
}

/** Empty checkpoint used when no prior status exists (fresh bundle). */
export const EMPTY_INDEX_CHECKPOINT: IndexCheckpointV2 = {
  last_indexed_rowid: null,
  last_indexed_epoch: null,
  schema_fingerprint: null,
  status: null,
  indexed_doc_count: null,
  source_doc_count: null,
  error_message: null,
}

/** Outcome of `planTantivyRebuild`. */
export type RebuildPlan =
  /** Source projection has the same row count and the index is
   *  marked `ready` with a matching fingerprint — nothing to do. */
  | {
      kind: 'skip'
      reason: 'already_indexed_up_to_date'
      fingerprint: string
      currentMaxRowid: number
    }
  /** Index dir is valid, fingerprint matches, and only new rows have
   *  arrived since `last_indexed_rowid`. The writer should open the
   *  existing index and append rows with `rowid > last_indexed_rowid`. */
  | {
      kind: 'incremental'
      reason: 'fingerprint_match_with_new_rows'
      fingerprint: string
      lastIndexedRowid: number
      currentMaxRowid: number
    }
  /** Force a full rebuild. Possible reasons:
   *
   *   - `no_prior_index`: no checkpoint yet, or `last_indexed_rowid <= 0`.
   *   - `fingerprint_mismatch`: schema changed between runs.
   *   - `caller_requested_overwrite`: explicit `--overwrite` flag.
   *   - `index_dir_invalid`: the on-disk Tantivy meta is missing.
   *   - `prior_run_failed`: previous run left `status === 'failed'`.
   *   - `epoch_mismatch`: caller passed a `currentEpoch` that does
   *     not match the checkpoint's `last_indexed_epoch` (or the
   *     checkpoint has no recorded epoch). Each bundle-v2 epoch is a
   *     full snapshot with its own synthetic rowid space, so any
   *     epoch change forces a complete re-index (CQ-115).
   */
  | {
      kind: 'full'
      reason:
        | 'no_prior_index'
        | 'fingerprint_mismatch'
        | 'caller_requested_overwrite'
        | 'index_dir_invalid'
        | 'prior_run_failed'
        | 'epoch_mismatch'
      fingerprint: string
      currentMaxRowid: number
    }

/** Inputs to the planner. The planner does NOT touch the
 *  filesystem; the caller validates the index dir up front and
 *  passes the boolean in. */
export interface PlanTantivyRebuildInput {
  /** Stored checkpoint from prior runs (may be empty). */
  checkpoint: IndexCheckpointV2
  /** Highest `rowid` in the current `search_docs` projection. */
  currentMaxRowid: number
  /** Result of `tantivyIndexDirIsValid(bundle.paths.tantivy)`. */
  indexDirValid: boolean
  /** Caller-supplied flag (`prosa index-v2 tantivy --overwrite`). */
  overwriteRequested?: boolean
  /** Current bundle epoch the caller is sourcing rows from. When
   *  provided, the planner forces `full / epoch_mismatch` if the
   *  checkpoint's `last_indexed_epoch` differs (or is `null` while
   *  a prior `ready` run exists). Optional so callers that have not
   *  yet adopted epoch tracking (legacy callers, the
   *  `tantivy-rebuild-plan` CLI command) keep working with the
   *  pre-CQ-115 behaviour; the bundle orchestrator
   *  (`planTantivyRebuildFromBundle` / `runTantivyRebuildForBundle`)
   *  always passes the value. */
  currentEpoch?: number
}

/**
 * Decide the next Tantivy run mode purely from inputs. The runtime
 * writer applies the plan; this function has no side effects.
 */
export function planTantivyRebuild(input: PlanTantivyRebuildInput): RebuildPlan {
  const fingerprint = currentTantivySchemaFingerprint()
  const { checkpoint, currentMaxRowid, indexDirValid } = input
  if (input.overwriteRequested === true) {
    return { kind: 'full', reason: 'caller_requested_overwrite', fingerprint, currentMaxRowid }
  }
  if (!indexDirValid) {
    return { kind: 'full', reason: 'index_dir_invalid', fingerprint, currentMaxRowid }
  }
  if (checkpoint.status === 'failed') {
    return { kind: 'full', reason: 'prior_run_failed', fingerprint, currentMaxRowid }
  }
  if (checkpoint.schema_fingerprint !== null && checkpoint.schema_fingerprint !== fingerprint) {
    return { kind: 'full', reason: 'fingerprint_mismatch', fingerprint, currentMaxRowid }
  }
  // CQ-115: when the caller passes the current epoch, refuse to
  // route to `incremental` / `skip` against rowids from a different
  // snapshot. Synthetic rowids in the v2 projection reset every
  // epoch (they are position-based inside one segment), so a
  // currentMaxRowid from epoch N cannot be compared with a
  // last_indexed_rowid from epoch N-1. A checkpoint that has a
  // prior `ready` state but no recorded epoch is also treated as a
  // mismatch — the planner cannot prove the rowid spaces line up.
  if (input.currentEpoch !== undefined) {
    const checkpointEpoch = checkpoint.last_indexed_epoch
    const hasPriorReady = checkpoint.status === 'ready' || (checkpoint.last_indexed_rowid ?? 0) > 0
    if (hasPriorReady && checkpointEpoch !== input.currentEpoch) {
      return { kind: 'full', reason: 'epoch_mismatch', fingerprint, currentMaxRowid }
    }
  }
  const lastIndexedRowid = checkpoint.last_indexed_rowid ?? 0
  if (lastIndexedRowid <= 0) {
    return { kind: 'full', reason: 'no_prior_index', fingerprint, currentMaxRowid }
  }
  if (currentMaxRowid <= lastIndexedRowid && checkpoint.status === 'ready') {
    return { kind: 'skip', reason: 'already_indexed_up_to_date', fingerprint, currentMaxRowid }
  }
  return {
    kind: 'incremental',
    reason: 'fingerprint_match_with_new_rows',
    fingerprint,
    lastIndexedRowid,
    currentMaxRowid,
  }
}

/**
 * Update a checkpoint after a successful Tantivy run. Returns a new
 * `IndexCheckpointV2` rather than mutating the input. Pass `epoch`
 * to record the bundle epoch the indexed rows came from so a future
 * planner call against a different epoch routes to
 * `full / epoch_mismatch` (CQ-115). `epoch` is optional for
 * back-compat with callers that pre-date the field; when omitted
 * the new checkpoint preserves the prior `last_indexed_epoch`
 * (which may itself be `null`).
 */
export function checkpointAfterRebuild(args: {
  prior: IndexCheckpointV2
  fingerprint: string
  newMaxRowid: number
  indexedDocCount: number
  sourceDocCount: number
  epoch?: number
}): IndexCheckpointV2 {
  return {
    ...args.prior,
    status: 'ready',
    schema_fingerprint: args.fingerprint,
    last_indexed_rowid: args.newMaxRowid,
    last_indexed_epoch: args.epoch ?? args.prior.last_indexed_epoch,
    indexed_doc_count: args.indexedDocCount,
    source_doc_count: args.sourceDocCount,
    error_message: null,
  }
}

/**
 * Update a checkpoint after a failed Tantivy run. The writer
 * records the error so the planner returns `prior_run_failed` on
 * the next attempt.
 */
export function checkpointAfterFailure(args: {
  prior: IndexCheckpointV2
  errorMessage: string
}): IndexCheckpointV2 {
  return {
    ...args.prior,
    status: 'failed',
    error_message: args.errorMessage,
  }
}
