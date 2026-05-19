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

  let derivedEntries: string[]
  try {
    const st = await lstat(paths.derived)
    if (st.isSymbolicLink()) {
      throw new Error(`summariseDerivedLayerFootprint: refusing to follow ${paths.derived} symlink (CQ-094 parallel).`)
    }
    if (!st.isDirectory()) {
      derivedEntries = []
    } else {
      const direntries = await readdir(paths.derived, { withFileTypes: true })
      derivedEntries = direntries.filter((d) => d.isDirectory()).map((d) => d.name)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      derivedEntries = []
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
  for (const name of derivedEntries) {
    if (KNOWN_SUBSYSTEM_NAMES.has(name)) continue
    const sub = await subsystemFootprint(join(paths.derived, name))
    if (sub.present) {
      other.present = true
      other.byte_count += sub.byte_count
      other.file_count += sub.file_count
    }
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
