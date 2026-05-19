// Top-level derived-layer status aggregator.
//
// `bundleDerivedStatus(bundleRoot)` is the one-call read for "what is
// the state of this bundle's derived layer?" — combines
// `tantivyIndexStatus` with the SessionBlob inventory shape so a
// dashboard / CLI status command / MCP `read_bundle_status` tool can
// paint the whole derived-layer picture in a single round-trip.
//
// Pure read path:
//
//   - No filesystem writes.
//   - No native binding calls (Tantivy writer, DuckDB executor not
//     required).
//   - All composed surfaces are themselves already saturated
//     pure-TS reads — `tantivyIndexStatus`,
//     `listSessionBlobSummaries`, `listSessionBlobEpochs`.
//
// Containment + validation guarantees inherit from the composed
// surfaces: a symlinked managed intermediate at `derived` or
// `derived/session-blob` causes the SessionBlob aggregation to
// throw; a symlinked `derived` or `derived/tantivy` makes the
// Tantivy index-dir probe collapse `index_dir_valid` to `false`.
//
// Result shape is the natural superset of the individual status
// readers — callers that only need one subsystem can still use the
// per-subsystem reader directly; this aggregator is the
// convenience for "give me everything" inventory views.

import { listSessionBlobEpochs } from './session-blob/listing.js'
import { type SessionBlobSummary, listSessionBlobSummaries } from './session-blob/summary.js'
import { type TantivyIndexStatus, tantivyIndexStatus } from './tantivy/status.js'

export interface BundleDerivedStatus {
  /** Tantivy local-index status snapshot — `checkpoint_present`,
   *  `index_dir_valid`, `ready_for_read`, etc. */
  tantivy: TantivyIndexStatus
  /** SessionBlob inventory: one row per session that has a pack in
   *  any epoch, sorted ascending by `session_id`. */
  session_summaries: SessionBlobSummary[]
  /** Total number of distinct sessions with at least one pack.
   *  Convenience getter for `session_summaries.length`. */
  session_count: number
  /** Sorted ascending set of epochs the SessionBlob writer has
   *  emitted to. May contain epochs with no `.pack` files (the
   *  writer created the dir but no sessions live there yet); the
   *  cross-epoch `session_summaries` union is the authoritative
   *  "which sessions exist" answer. */
  session_blob_epochs: number[]
}

/**
 * One-call read-only snapshot of the bundle's derived layer.
 *
 *   - `tantivy`: from `tantivyIndexStatus(bundleRoot)`.
 *   - `session_summaries`: from `listSessionBlobSummaries(bundleRoot)`.
 *   - `session_blob_epochs`: from `listSessionBlobEpochs(bundleRoot)`.
 *   - `session_count`: convenience `session_summaries.length`.
 *
 * Composed reads run concurrently via `Promise.all` so the
 * top-level latency is the slowest single-subsystem read. Each
 * composed surface enforces its own containment + validation; a
 * failure in any subsystem propagates unchanged.
 *
 * Suitable for `prosa bundle status` CLI / MCP `read_bundle_status`
 * tool / web bundle-overview panel. The runtime Parquet compaction
 * planner is intentionally NOT bundled because it depends on the
 * projection layer existing under `epochs/<n>/projection/` — a
 * caller that knows the projection is present can compose
 * `planCompaction(bundleRoot)` themselves.
 */
export async function bundleDerivedStatus(bundleRoot: string): Promise<BundleDerivedStatus> {
  const [tantivy, sessionSummaries, sessionBlobEpochs] = await Promise.all([
    tantivyIndexStatus(bundleRoot),
    listSessionBlobSummaries(bundleRoot),
    listSessionBlobEpochs(bundleRoot),
  ])
  return {
    tantivy,
    session_summaries: sessionSummaries,
    session_count: sessionSummaries.length,
    session_blob_epochs: sessionBlobEpochs,
  }
}
