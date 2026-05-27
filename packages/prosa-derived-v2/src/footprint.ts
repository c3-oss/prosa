// Derived-layer disk footprint — total bytes per subsystem.
//
// Operators auditing a bundle want a one-call answer to "how much
// disk does this bundle's derived layer use?". The maintenance
// summary already gives them the projection rollup, but
// session-blob bytes, tantivy index bytes, and analytics scratch
// bytes are not aggregated anywhere.
//
// This module walks the `<bundleRoot>/derived/` subtree and emits
// a per-subsystem breakdown:
//
//   - `session-blob/`: every SessionBlobPackV2 pack file.
//   - `tantivy/`: Tantivy index, checkpoint, meta files.
//   - `analytics/`: DuckDB scratch + materialised reports
//     (currently unused; reported as zero until the runtime
//     analytics executor lands).
//
// Pure-read. We do NOT include the per-epoch projection segments
// or the compaction outputs (those live under `epochs/`, not
// `derived/`); see `summariseProjectionSegments` for the
// projection side. `bundleRoot` itself is not walked — only the
// `derived/` subtree.
//
// Subdirectories that do not exist report
// `{ byte_count: 0, file_count: 0, present: false }`. Intermediate
// symlinks on the walk are refused via lstat (CQ-094/CQ-098
// containment parallel) so the audit cannot follow a symlinked
// `derived/session-blob` out of the bundle.

import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { derivedPaths } from './derived-layout.js'

export interface SubsystemFootprint {
  byte_count: number
  file_count: number
  /** True iff the subsystem directory exists on disk. `false` means
   *  the subsystem has not been written yet (or was cleared). */
  present: boolean
}

export interface DerivedLayerFootprint {
  /** Total bytes across every regular file under
   *  `<bundleRoot>/derived/`. Sum of the three subsystem byte
   *  counts (plus any other subdirectory's bytes — see
   *  `other.byte_count`). */
  total_bytes: number
  session_blob: SubsystemFootprint
  tantivy: SubsystemFootprint
  analytics: SubsystemFootprint
  /** Any other top-level subdirectory under `derived/` not
   *  recognised by name. Reports the aggregate so forward-
   *  compatible additions to the layout are still visible in the
   *  total. Empty when `derived/` only contains the three known
   *  subsystems. */
  other: SubsystemFootprint
}

interface WalkAccumulator {
  byte_count: number
  file_count: number
}

async function walkDirectoryBytes(path: string): Promise<WalkAccumulator> {
  let entries: Array<{ name: string; isDirectory: boolean; isFile: boolean }>
  try {
    const direntries = await readdir(path, { withFileTypes: true })
    entries = direntries.map((d) => ({ name: d.name, isDirectory: d.isDirectory(), isFile: d.isFile() }))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { byte_count: 0, file_count: 0 }
    }
    throw err
  }
  const acc: WalkAccumulator = { byte_count: 0, file_count: 0 }
  for (const entry of entries) {
    const child = join(path, entry.name)
    // Refuse symlinks (CQ-094/CQ-098 parallel) — the audit must not
    // follow them out of the bundle. Use lstat to check the entry
    // type directly so a hand-crafted symlink-to-file does not
    // inflate the byte count via the deref'd target.
    const st = await lstat(child)
    if (st.isSymbolicLink()) {
      throw new Error(
        `summariseDerivedLayerFootprint: refusing to follow symlink at ${child} (CQ-094 parallel; resolve the symlink configuration manually).`,
      )
    }
    if (st.isDirectory()) {
      const sub = await walkDirectoryBytes(child)
      acc.byte_count += sub.byte_count
      acc.file_count += sub.file_count
    } else if (st.isFile()) {
      acc.byte_count += st.size
      acc.file_count += 1
    }
  }
  return acc
}

async function subsystemFootprint(path: string): Promise<SubsystemFootprint> {
  let present: boolean
  try {
    const st = await lstat(path)
    if (st.isSymbolicLink()) {
      throw new Error(
        `summariseDerivedLayerFootprint: refusing to follow subsystem symlink at ${path} (CQ-094 parallel).`,
      )
    }
    present = st.isDirectory()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { byte_count: 0, file_count: 0, present: false }
    }
    throw err
  }
  if (!present) return { byte_count: 0, file_count: 0, present: false }
  const acc = await walkDirectoryBytes(path)
  return { ...acc, present: true }
}

const KNOWN_SUBSYSTEM_NAMES = new Set(['session-blob', 'tantivy', 'analytics'])

/**
 * Walk `<bundleRoot>/derived/` and report total + per-subsystem
 * byte / file counts. Bundles with no derived tree at all return
 * the all-zero shape with every subsystem `present: false`.
 *
 * Intermediate or final symlinks under `derived/` are refused
 * (CQ-094 parallel) so an operator cannot accidentally have the
 * footprint audit follow a symlink out of the bundle.
 *
 * Forward-compatible: unknown subdirectories under `derived/`
 * roll into `other` so newly added derived artifacts still
 * appear in `total_bytes`.
 */
export async function summariseDerivedLayerFootprint(bundleRoot: string): Promise<DerivedLayerFootprint> {
  const paths = derivedPaths(bundleRoot)

  // CQ-112: enumerate EVERY direct child of `derived/`, not only
  // directories. We must either account for it (in `other`) or
  // refuse it (symlink). Silently ignoring entries — files or
  // unknown symlinks — would let the footprint under-report disk
  // usage and would let a top-level symlink escape the audit.
  let derivedDirEntries: Array<{ name: string; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean }>
  try {
    const st = await lstat(paths.derived)
    if (st.isSymbolicLink()) {
      throw new Error(`summariseDerivedLayerFootprint: refusing to follow ${paths.derived} symlink (CQ-094 parallel).`)
    }
    if (!st.isDirectory()) {
      derivedDirEntries = []
    } else {
      const direntries = await readdir(paths.derived, { withFileTypes: true })
      derivedDirEntries = direntries.map((d) => ({
        name: d.name,
        isDirectory: d.isDirectory(),
        isFile: d.isFile(),
        isSymbolicLink: d.isSymbolicLink(),
      }))
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      derivedDirEntries = []
    } else {
      throw err
    }
  }

  const [sessionBlob, tantivy, analytics] = await Promise.all([
    subsystemFootprint(paths.sessionBlob),
    subsystemFootprint(paths.tantivy),
    subsystemFootprint(paths.analytics),
  ])

  const other: SubsystemFootprint = { byte_count: 0, file_count: 0, present: false }
  for (const entry of derivedDirEntries) {
    if (KNOWN_SUBSYSTEM_NAMES.has(entry.name)) continue
    const child = join(paths.derived, entry.name)
    // CQ-112: refuse top-level symlinks just like every level
    // below. The readdir Dirent's `isSymbolicLink()` only reports
    // the immediate symlink state without dereferencing — exactly
    // what we want here. Use lstat to confirm before erroring so
    // a race-condition swap-after-readdir still triggers the same
    // safety path.
    const childSt = await lstat(child)
    if (childSt.isSymbolicLink() || entry.isSymbolicLink) {
      throw new Error(
        `summariseDerivedLayerFootprint: refusing to follow top-level symlink at ${child} (CQ-112; resolve the symlink configuration manually).`,
      )
    }
    if (childSt.isDirectory()) {
      const sub = await subsystemFootprint(child)
      if (sub.present) {
        other.present = true
        other.byte_count += sub.byte_count
        other.file_count += sub.file_count
      }
    } else if (childSt.isFile()) {
      // CQ-112: top-level regular files under `derived/` are
      // unknown but legitimate — count them toward `other` so the
      // total stays accurate.
      other.present = true
      other.byte_count += childSt.size
      other.file_count += 1
    }
    // Other entry kinds (sockets, fifos, devices) are silently
    // skipped — they cannot legitimately occur inside a bundle and
    // there is no sensible way to "count" them.
  }

  const totalBytes = sessionBlob.byte_count + tantivy.byte_count + analytics.byte_count + other.byte_count
  return {
    total_bytes: totalBytes,
    session_blob: sessionBlob,
    tantivy,
    analytics,
    other,
  }
}
