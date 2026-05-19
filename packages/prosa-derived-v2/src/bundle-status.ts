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

import { listProjectionSegments } from './compaction/segments.js'
import { listSessionBlobEpochs, listSessionBlobSessions } from './session-blob/listing.js'
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

/**
 * Sorted ascending set of every epoch number where the bundle's
 * derived layer has at least one artifact — meaning at least one
 * SessionBlob `.pack` file actually lives in `epoch-<n>/`, or at
 * least one Parquet projection segment lives in
 * `epochs/<n>/projection/`. The result is the deduplicated union
 * of those two sets.
 *
 * CQ-104: only epochs with a concrete artifact contribute. An
 * empty `epoch-<n>/` directory (e.g. one the writer created but
 * has not populated with any session pack yet) is NOT counted —
 * the audit/GC keep-set must reflect what is actually on disk.
 * `listSessionBlobEpochs` alone would over-report by returning
 * candidate epoch directories regardless of pack presence; the
 * composition below filters those out via
 * `listSessionBlobSessions(epoch)` per candidate.
 *
 * Use cases:
 *
 *   - Audit reports: "this bundle has derived artifacts for epochs
 *     [0, 1, 3, 5, 7]" — the auditor wants the union, not the
 *     per-subsystem split.
 *   - GC planning: every epoch returned has at least one derived
 *     file that needs to survive the next prune; missing epochs
 *     are safe to omit from the keep set.
 *   - Health probes: a bundle with zero touched epochs has no
 *     derived layer to read from.
 *
 * Containment + validation are inherited from the composed
 * surfaces. A symlinked `<bundleRoot>/derived/session-blob` throws
 * via `listSessionBlobEpochs`; a per-epoch CQ-098 violation
 * throws via `listSessionBlobSessions`; a symlinked
 * `<bundleRoot>/epochs` throws via `listProjectionSegments`.
 * Returns `[]` on a fresh bundle.
 */
export async function derivedLayerEpochsTouched(bundleRoot: string): Promise<number[]> {
  const [sessionBlobCandidateEpochs, projectionSegments] = await Promise.all([
    listSessionBlobEpochs(bundleRoot),
    listProjectionSegments(bundleRoot),
  ])
  const touched = new Set<number>()
  for (const epoch of sessionBlobCandidateEpochs) {
    const sessions = await listSessionBlobSessions({ bundleRoot, epoch })
    if (sessions.length > 0) touched.add(epoch)
  }
  for (const segment of projectionSegments) {
    touched.add(segment.epoch)
  }
  return [...touched].sort((a, b) => a - b)
}
