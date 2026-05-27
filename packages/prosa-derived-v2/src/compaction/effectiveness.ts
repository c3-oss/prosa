// Compaction effectiveness rollup — bytes-in vs bytes-out per
// persisted compaction-seq.
//
// The compaction planner answers "should we compact?". The
// compaction-execution-plan composer answers "how do we run it?".
// `listCompactedOutputs` answers "did it land cleanly?". This
// module answers "was it worth it?" — for each persisted manifest,
// how many bytes of source segments did it merge in, how many
// bytes are sitting on disk now, and what reduction does that
// represent.
//
// Pure-read: walks `listCompactedOutputs` (which itself reads
// every persisted `compact.manifest.json`) and joins by
// compaction-seq with the manifest's `total_bytes_in` /
// per-entity `superseded[]` byte sums.
//
// Inconsistent rows (missing outputs) report `bytes_out: null`
// and `reduction_ratio: null` — the row stays in the listing for
// auditability but does not contribute to the top-level
// `bytes_saved` / `reduction_ratio` totals. An operator dashboard
// pivots on `consistent: true|false` to decide whether the row is
// load-bearing for decision-making.

import { type CompactManifestV2, readCompactManifestV2 } from './manifest.js'
import { type CompactedManifestAudit, listCompactedOutputs } from './outputs.js'

export interface CompactionEffectivenessRow {
  /** Sequence number the manifest declares. */
  compaction_seq: number
  /** True iff every entity output the manifest names exists as a
   *  regular file with a non-null byte length. Mirrors
   *  `CompactedManifestAudit.consistent`. */
  consistent: boolean
  /** Sum of `superseded[].byte_length` across every entity in this
   *  manifest. The byte total the runtime worker merged away. */
  bytes_in: number
  /** Sum of on-disk byte lengths across every entity output. `null`
   *  when the row is inconsistent (we report partial sums on the
   *  per-output audit, but `bytes_out` at this granularity is only
   *  meaningful for a complete merge). */
  bytes_out: number | null
  /** `bytes_in - bytes_out` when consistent; `null` otherwise. */
  bytes_saved: number | null
  /** `bytes_saved / bytes_in` in `[0, 1]` when consistent and
   *  `bytes_in > 0`; `0` when consistent and `bytes_in === 0`
   *  (degenerate); `null` otherwise. */
  reduction_ratio: number | null
  /** Number of superseded segments the manifest declares. */
  superseded_segment_count: number
  /** Number of entity outputs the manifest declares. */
  output_count: number
  /** Number of declared entity outputs that are missing on disk.
   *  `0` for consistent rows by definition. */
  missing_output_count: number
}

export interface CompactionEffectivenessSummary {
  /** Per-compaction-seq effectiveness rows, sorted by
   *  `compaction_seq` ascending. Inherits the order from
   *  `listCompactedOutputs`. */
  rows: CompactionEffectivenessRow[]
  /** Roll-up across consistent rows only. Inconsistent rows are
   *  excluded from `bytes_out`, `bytes_saved`, and
   *  `reduction_ratio` because their on-disk state is incomplete.
   *  `bytes_in_consistent` mirrors the sum of `bytes_in` across
   *  consistent rows, so the ratio is well-defined. */
  totals: {
    consistent_count: number
    inconsistent_count: number
    bytes_in_consistent: number
    bytes_out: number
    bytes_saved: number
    reduction_ratio: number
  }
}

interface ManifestInputBytes {
  total_in: number
  segment_count: number
  output_count: number
}

function sumManifestInputBytes(manifest: CompactManifestV2): ManifestInputBytes {
  let totalIn = 0
  let segmentCount = 0
  for (const entity of manifest.entities) {
    totalIn += entity.total_bytes_in
    segmentCount += entity.superseded.length
  }
  return { total_in: totalIn, segment_count: segmentCount, output_count: manifest.entities.length }
}

function sumAuditOutputBytes(audit: CompactedManifestAudit): { sum: number; missing: number } {
  let sum = 0
  let missing = 0
  for (const output of audit.entity_outputs) {
    if (output.exists && output.byte_length !== null) {
      sum += output.byte_length
    } else {
      missing += 1
    }
  }
  return { sum, missing }
}

/**
 * Compose `listCompactedOutputs` with a fresh re-read of every
 * persisted manifest into a per-compaction-seq effectiveness
 * rollup. The audit gives us output sizes; the manifest gives us
 * input sizes. We deliberately re-read the manifest rather than
 * threading byte sums through `listCompactedOutputs` so the audit
 * primitive stays narrow.
 *
 * Empty bundles (no `epochs/`, no persisted manifests) return
 * `{ rows: [], totals: { ... all zeros ... } }`.
 *
 * Inconsistent rows are kept in the listing but excluded from
 * top-level totals — see `CompactionEffectivenessRow.bytes_out`
 * doc for rationale.
 */
export async function summariseCompactionEffectiveness(bundleRoot: string): Promise<CompactionEffectivenessSummary> {
  const audits = await listCompactedOutputs(bundleRoot)
  const rows: CompactionEffectivenessRow[] = []
  let consistentCount = 0
  let inconsistentCount = 0
  let bytesInConsistent = 0
  let bytesOut = 0
  for (const audit of audits) {
    const manifest = await readCompactManifestV2(bundleRoot, audit.compaction_seq)
    const inputs = sumManifestInputBytes(manifest)
    const outputs = sumAuditOutputBytes(audit)
    const consistent = audit.consistent
    let row: CompactionEffectivenessRow
    if (consistent) {
      const reductionRatio = inputs.total_in === 0 ? 0 : (inputs.total_in - outputs.sum) / inputs.total_in
      row = {
        compaction_seq: audit.compaction_seq,
        consistent: true,
        bytes_in: inputs.total_in,
        bytes_out: outputs.sum,
        bytes_saved: inputs.total_in - outputs.sum,
        reduction_ratio: reductionRatio,
        superseded_segment_count: inputs.segment_count,
        output_count: inputs.output_count,
        missing_output_count: 0,
      }
      consistentCount += 1
      bytesInConsistent += inputs.total_in
      bytesOut += outputs.sum
    } else {
      row = {
        compaction_seq: audit.compaction_seq,
        consistent: false,
        bytes_in: inputs.total_in,
        bytes_out: null,
        bytes_saved: null,
        reduction_ratio: null,
        superseded_segment_count: inputs.segment_count,
        output_count: inputs.output_count,
        missing_output_count: outputs.missing,
      }
      inconsistentCount += 1
    }
    rows.push(row)
  }

  const bytesSaved = bytesInConsistent - bytesOut
  const reductionRatio = bytesInConsistent === 0 ? 0 : bytesSaved / bytesInConsistent
  return {
    rows,
    totals: {
      consistent_count: consistentCount,
      inconsistent_count: inconsistentCount,
      bytes_in_consistent: bytesInConsistent,
      bytes_out: bytesOut,
      bytes_saved: bytesSaved,
      reduction_ratio: reductionRatio,
    },
  }
}
