// NDJSON projection segment listing.
//
// Companion to `listProjectionSegments` (which enumerates `.parquet`
// projection segments). The v2 importers / `compile-v2` emit
// canonical projection segments as `<entity>.prosa-projection.ndjson`
// where `<entity>` is the singular canonical-entity name
// (`session`, `message`, `tool_call`, …). The analytics runtime
// reads these directly so a fixture-backed compile-v2 bundle can
// drive `runAnalyticsExecution` without first materialising
// Parquet (CQ-116).
//
// Containment guards mirror `listProjectionSegments` verbatim:
//
//   - `<bundleRoot>/epochs` is `lstat`ed; a symlink there throws so a
//     hostile setup cannot smuggle in external `.ndjson` files;
//   - per-epoch / per-projection / per-file symlinks are dropped;
//   - files whose name does not end in `.prosa-projection.ndjson` are
//     dropped.
//
// Returns `[]` for fresh bundles (no `epochs/` dir).

import { lstat, readdir } from 'node:fs/promises'
import { join, sep } from 'node:path'

/** One canonical-projection NDJSON segment under
 *  `<bundleRoot>/epochs/<n>/projection/`. */
export interface NdjsonProjectionSegment {
  /** Canonical entity name parsed from the filename (singular —
   *  `session`, `message`, `tool_call`, …). Matches
   *  `CanonicalEntityType` values from `@c3-oss/prosa-types-v2`. */
  entityType: string
  /** Numeric epoch the segment lives in. */
  epoch: number
  /** Path relative to the bundle root (platform separator). */
  path: string
  /** Absolute on-disk path. */
  absPath: string
  /** File size in bytes from `stat`. */
  byteLength: number
}

const NDJSON_SUFFIX = '.prosa-projection.ndjson'

/**
 * Enumerate every `<entity>.prosa-projection.ndjson` segment under
 * the bundle. Result is sorted ascending by `(epoch, entityType)`
 * so callers get deterministic output without their own re-sorting
 * step.
 */
export async function listProjectionNdjsonSegments(bundleRoot: string): Promise<NdjsonProjectionSegment[]> {
  const epochsDir = join(bundleRoot, 'epochs')
  try {
    const epochsStat = await lstat(epochsDir)
    if (epochsStat.isSymbolicLink()) {
      throw new Error(
        `listProjectionNdjsonSegments: refusing to enumerate — ${epochsDir} is a symlink. Resolve the symlink configuration manually before retrying.`,
      )
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw err
  }
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

  const segments: NdjsonProjectionSegment[] = []
  for (const { name, epoch } of numericEpochs) {
    const epochAbsDir = join(epochsDir, name)
    try {
      const epochStat = await lstat(epochAbsDir)
      if (epochStat.isSymbolicLink() || !epochStat.isDirectory()) continue
    } catch {
      continue
    }
    const projectionDir = join(epochAbsDir, 'projection')
    try {
      const projStat = await lstat(projectionDir)
      if (projStat.isSymbolicLink() || !projStat.isDirectory()) continue
    } catch {
      continue
    }
    let entries: string[]
    try {
      entries = await readdir(projectionDir)
    } catch {
      continue
    }
    entries.sort()
    for (const fileName of entries) {
      if (!fileName.endsWith(NDJSON_SUFFIX)) continue
      const entityType = fileName.slice(0, -NDJSON_SUFFIX.length)
      const absPath = join(projectionDir, fileName)
      let info: { size: number; isFile: boolean; isSymlink: boolean }
      try {
        const st = await lstat(absPath)
        info = { size: st.size, isFile: st.isFile(), isSymlink: st.isSymbolicLink() }
      } catch {
        continue
      }
      if (info.isSymlink || !info.isFile) continue
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
