// Parquet projection segment listing.
//
// `listProjectionSegments(bundleRoot)` walks `<bundleRoot>/epochs/<n>/projection/`
// and returns every `*.parquet` file as a `ProjectionSegment` record:
// epoch, entity type, absolute + relative paths, byte length. The
// compaction planner does this walk internally; this surface
// exposes it as a public read for callers that need the raw segment
// inventory without applying the compaction-policy decision.
//
// Use cases:
//
//   - CLI inventory ("this bundle has N projection segments across
//     M epochs, total X MiB").
//   - Audit / debugging tools that need a flat list of every
//     emitted projection file.
//   - The future Parquet merge worker (currently blocked behind the
//     `@duckdb/node-api` workspace allowlist) that will enumerate
//     inputs.
//
// The walk mirrors the planner's filtering rules verbatim:
//
//   - Only digit-prefixed `epochs/<n>/` entries are considered;
//     `epochs/compact-<N>/` directories are skipped so already-
//     compacted output never re-surfaces in the live segment list.
//   - Per-epoch `projection/` is read with `readdir`; ENOENT
//     collapses to "epoch has no projection files" (skipped silently).
//   - Files whose name does not end in `.parquet` are dropped.
//
// Pure read path — no Parquet decoding, no DuckDB. Suitable for any
// surface regardless of the `@duckdb/node-api` allowlist gate that
// the runtime merge worker needs.

import { readdir, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'

export interface ProjectionSegment {
  /** Canonical entity name parsed from the Parquet filename (e.g.
   *  `sessions`, `messages`, `tool_calls`). */
  entityType: string
  /** Numeric epoch the segment lives in. */
  epoch: number
  /** Path relative to the bundle root (using the platform separator),
   *  matching the `path` field on the compaction planner's
   *  `SegmentRef`. */
  path: string
  /** Absolute on-disk path. */
  absPath: string
  /** File size in bytes from `stat`. */
  byteLength: number
}

/**
 * Enumerate every Parquet projection segment under the bundle.
 *
 * Returns a sorted ascending array — primary sort by `epoch`,
 * secondary by `entityType` — so callers get deterministic output
 * without their own re-sorting step.
 *
 * Returns `[]` when the bundle has no `epochs/` directory at all
 * (freshly initialised bundle) or every epoch dir is empty. Per-
 * epoch `stat` failures (e.g. a file unlinked between `readdir`
 * and `stat`) drop that segment from the result rather than
 * aborting the whole walk; callers see the bundle as it is at the
 * end of the walk.
 */
export async function listProjectionSegments(bundleRoot: string): Promise<ProjectionSegment[]> {
  const epochsDir = join(bundleRoot, 'epochs')
  let epochs: string[]
  try {
    epochs = await readdir(epochsDir)
  } catch {
    return []
  }
  const numericEpochs = epochs
    .map((name) => ({ name, epoch: Number(name) }))
    .filter((e) => Number.isInteger(e.epoch) && !e.name.startsWith('compact-'))
    .sort((a, b) => a.epoch - b.epoch)

  const segments: ProjectionSegment[] = []
  for (const { name, epoch } of numericEpochs) {
    const projectionDir = join(epochsDir, name, 'projection')
    let entries: string[]
    try {
      entries = await readdir(projectionDir)
    } catch {
      continue
    }
    // Sort entries so per-epoch output is deterministic without the
    // overall sort below relying on `readdir`'s platform-specific
    // order.
    entries.sort()
    for (const fileName of entries) {
      if (!fileName.endsWith('.parquet')) continue
      const entityType = fileName.replace(/\.parquet$/, '')
      const absPath = join(projectionDir, fileName)
      let info: { size: number }
      try {
        info = await stat(absPath)
      } catch {
        continue
      }
      segments.push({
        entityType,
        epoch,
        path: `epochs${sep}${name}${sep}projection${sep}${fileName}`,
        absPath,
        byteLength: info.size,
      })
    }
  }
  return segments
}

export interface ProjectionSegmentRollup {
  /** Number of segments contributing to this rollup row. */
  count: number
  /** Total `byteLength` summed across those segments. */
  bytes: number
}

export interface ProjectionSegmentsSummary {
  /** Total `byteLength` summed across every segment in the bundle. */
  total_bytes: number
  /** Total segment count. */
  total_segments: number
  /** Per-entity rollup, keyed by `entityType`. Includes every entity
   *  that has at least one segment in any epoch. */
  by_entity: Record<string, ProjectionSegmentRollup>
  /** Per-epoch rollup, keyed by the numeric epoch (stringified for
   *  JSON serializability). Includes every epoch that has at least
   *  one segment under `projection/`. */
  by_epoch: Record<string, ProjectionSegmentRollup>
}

/**
 * Roll up `listProjectionSegments(bundleRoot)` into total /
 * per-entity / per-epoch byte and count stats. Suitable for CLI
 * inventory rows ("12 segments / 318 MiB across 3 epochs and 5
 * entity types") and audit reports without forcing the caller to
 * re-fold the flat list.
 *
 * Empty bundle yields `{ total_bytes: 0, total_segments: 0,
 * by_entity: {}, by_epoch: {} }`. Inherits the listing's filtering
 * (digit-prefixed epoch dirs, `.parquet` files, `compact-<NNNN>`
 * skipped) — what the listing reports is what the summary rolls up.
 */
export async function summariseProjectionSegments(bundleRoot: string): Promise<ProjectionSegmentsSummary> {
  const segments = await listProjectionSegments(bundleRoot)
  const summary: ProjectionSegmentsSummary = {
    total_bytes: 0,
    total_segments: segments.length,
    by_entity: {},
    by_epoch: {},
  }
  for (const segment of segments) {
    summary.total_bytes += segment.byteLength
    const entityRollup = summary.by_entity[segment.entityType] ?? { count: 0, bytes: 0 }
    entityRollup.count += 1
    entityRollup.bytes += segment.byteLength
    summary.by_entity[segment.entityType] = entityRollup
    const epochKey = String(segment.epoch)
    const epochRollup = summary.by_epoch[epochKey] ?? { count: 0, bytes: 0 }
    epochRollup.count += 1
    epochRollup.bytes += segment.byteLength
    summary.by_epoch[epochKey] = epochRollup
  }
  return summary
}
