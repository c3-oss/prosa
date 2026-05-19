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
   */
  | {
      kind: 'full'
      reason:
        | 'no_prior_index'
        | 'fingerprint_mismatch'
        | 'caller_requested_overwrite'
        | 'index_dir_invalid'
        | 'prior_run_failed'
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
 * `IndexCheckpointV2` rather than mutating the input.
 */
export function checkpointAfterRebuild(args: {
  prior: IndexCheckpointV2
  fingerprint: string
  newMaxRowid: number
  indexedDocCount: number
  sourceDocCount: number
}): IndexCheckpointV2 {
  return {
    ...args.prior,
    status: 'ready',
    schema_fingerprint: args.fingerprint,
    last_indexed_rowid: args.newMaxRowid,
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
