// Tantivy index status reader.
//
// `tantivyIndexStatus(bundleRoot)` composes the existing checkpoint
// reader (`readIndexCheckpoint`), the on-disk probe
// (`tantivyIndexDirIsValid`), and the current schema fingerprint
// (`currentTantivySchemaFingerprint`) into one CLI/MCP-friendly
// status object answering:
//
//   - Is a checkpoint present?
//   - Is the on-disk index directory in a state the planner
//     considers recoverable?
//   - Does the checkpoint's schema fingerprint match the current
//     pinned schema (i.e. would the planner force `full`)?
//   - Is search ready to serve queries — checkpoint says `ready`,
//     index dir valid, fingerprint matches, no recorded error?
//
// Pure read path: no filesystem writes, no native-binding calls.
// Suitable for `prosa index-v2 status` CLI commands and the MCP
// `read_index_status` tool without requiring the
// `@oxdev03/node-tantivy-binding` allowlist expansion that the
// Tantivy native writer needs.

import { readIndexCheckpoint } from './checkpoint-store.js'
import { tantivyIndexDirIsValid } from './index-dir.js'
import type { IndexCheckpointV2 } from './rebuild-plan.js'
import { currentTantivySchemaFingerprint } from './schema.js'

export interface TantivyIndexStatus {
  /** True iff `<bundleRoot>/derived/tantivy/checkpoint.json` exists
   *  and parses as a valid `IndexCheckpointV2`. */
  checkpoint_present: boolean
  /** True iff the on-disk index directory passes
   *  `tantivyIndexDirIsValid` (CQ-094/CQ-096-hardened probe). */
  index_dir_valid: boolean
  /** Checkpoint snapshot, or `null` when no checkpoint exists. */
  checkpoint: IndexCheckpointV2 | null
  /** Current pinned schema fingerprint (`blake3:<hex>`). Always
   *  populated — derived from `TANTIVY_SCHEMA_FIELDS`. */
  current_schema_fingerprint: string
  /** True iff the checkpoint's `schema_fingerprint` equals
   *  `current_schema_fingerprint`. `false` when the checkpoint is
   *  absent or carries a `null`/mismatched fingerprint. The planner
   *  forces `full` on mismatch, so this flag mirrors the planner's
   *  `fingerprint_mismatch` reason. */
  schema_fingerprint_match: boolean
  /** True iff every "is search ready?" gate passes:
   *
   *    - `checkpoint_present`
   *    - `checkpoint.status === 'ready'`
   *    - `checkpoint.error_message === null`
   *    - `index_dir_valid`
   *    - `schema_fingerprint_match`
   *
   *  CLI / MCP surfaces use this as the single boolean to gate
   *  "would a query against the index succeed?" without
   *  re-implementing the gate logic per call site. */
  ready_for_read: boolean
}

/**
 * Read-only status snapshot for the Tantivy local index of a bundle.
 * Calls three pure read paths (checkpoint, dir probe, schema
 * fingerprint) and aggregates the results.
 *
 * Containment + safety:
 *
 *   - `readIndexCheckpoint` already throws on malformed checkpoint
 *     JSON (not silently empty), so corrupt state surfaces rather
 *     than masquerading as "no checkpoint".
 *   - `tantivyIndexDirIsValid` enforces the CQ-094 final-component
 *     and CQ-096 intermediate symlink containment; a symlink at
 *     any managed path collapses to `index_dir_valid: false`.
 *   - The fingerprint compare is constant-string equality; the
 *     pinned fingerprint always reflects the current
 *     `TANTIVY_SCHEMA_FIELDS` order.
 *
 * No write side effects. Suitable for paged status pages, MCP
 * `read_index_status` tool, and CLI `index-v2 status` printout.
 */
export async function tantivyIndexStatus(bundleRoot: string): Promise<TantivyIndexStatus> {
  const [checkpoint, indexDirValid] = await Promise.all([
    readIndexCheckpoint(bundleRoot),
    tantivyIndexDirIsValid(bundleRoot),
  ])
  const currentFingerprint = currentTantivySchemaFingerprint()
  const fingerprintMatch = checkpoint?.schema_fingerprint === currentFingerprint
  const readyForRead =
    checkpoint !== null &&
    checkpoint.status === 'ready' &&
    checkpoint.error_message === null &&
    indexDirValid &&
    fingerprintMatch
  return {
    checkpoint_present: checkpoint !== null,
    index_dir_valid: indexDirValid,
    checkpoint,
    current_schema_fingerprint: currentFingerprint,
    schema_fingerprint_match: fingerprintMatch,
    ready_for_read: readyForRead,
  }
}
