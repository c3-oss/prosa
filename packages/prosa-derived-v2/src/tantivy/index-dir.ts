// Tantivy index directory layout + fast validity probe.
//
// The rebuild planner takes a boolean `indexDirValid` input and never
// touches the filesystem itself. This module is the on-disk probe
// that callers use to compute that boolean before invoking
// `planTantivyRebuild`.
//
// "Valid" here is a fast best-effort check: the canonical index path
// is a real directory (no symlinks), `meta.json` is a real file (no
// symlinks), and `meta.json` parses as JSON containing a `segments`
// array. The native writer (`@oxdev03/node-tantivy-binding`, added
// later) performs a full integrity check when it opens the index;
// this probe deliberately stops short of that so the planner can
// keep its decision pure-TS and ENOENT-tolerant.
//
// CQ-094: the probe uses `lstat()` on both the directory and the
// manifest so a planted symlink escape (e.g.
// `derived/tantivy/index -> /etc/passwd.d`) cannot be reported as a
// recoverable index. Future writer code may open, delete, or recreate
// this path during full/incremental rebuilds, so symlinked surfaces
// must fail closed before the native writer lands.
//
// `clearTantivyIndexDir` extends the same symlink-rejection contract
// to the `full`-rebuild reset path: the planner returns
// `kind: 'full'` when the prior index is unrecoverable, and callers
// must wipe the index directory before the native writer opens it.
// That removal MUST refuse to traverse a symlink at the index path,
// or `rm -rf` could delete an arbitrary external directory.

import { lstat, mkdir, readFile, rm } from 'node:fs/promises'

import { derivedPaths } from '../derived-layout.js'

/** Canonical on-disk path of the Tantivy index directory inside a
 *  bundle. The native writer creates `meta.json` plus the segment
 *  files under this path. */
export function tantivyIndexDir(bundleRoot: string): string {
  return derivedPaths(bundleRoot).tantivyIndex
}

/** Canonical path of the Tantivy `meta.json` manifest. */
export function tantivyMetaPath(bundleRoot: string): string {
  return derivedPaths(bundleRoot).tantivyMeta
}

/**
 * Fast best-effort probe answering: should the planner treat the
 * on-disk Tantivy index as recoverable? Returns `true` when:
 *
 *   - `<bundleRoot>/derived/tantivy/index` is a real directory
 *     (not a symlink — CQ-094);
 *   - `<bundleRoot>/derived/tantivy/index/meta.json` is a real
 *     regular file (not a symlink — CQ-094);
 *   - `meta.json` parses as JSON and is an object containing a
 *     `segments` field that is an array (even an empty one).
 *
 * Returns `false` on any negative result, including ENOENT, a
 * symlink at either path (even one pointing at a valid target), a
 * file where the directory should be, malformed JSON, or a missing
 * / non-array `segments` field. The native writer will still
 * re-validate the on-disk index when it opens it; this probe is
 * intentionally cheap and lets the planner decide between `full`
 * (no/garbage index) and `incremental` (recoverable index) without
 * paying for the native binding.
 */
export async function tantivyIndexDirIsValid(bundleRoot: string): Promise<boolean> {
  const dir = tantivyIndexDir(bundleRoot)
  try {
    const dirStat = await lstat(dir)
    // Reject symlinks unconditionally: a symlink at the index path
    // can point at an arbitrary external location and let a future
    // writer touch files outside the bundle root.
    if (dirStat.isSymbolicLink()) return false
    if (!dirStat.isDirectory()) return false
  } catch {
    return false
  }
  const meta = tantivyMetaPath(bundleRoot)
  let bytes: Buffer
  try {
    const fileStat = await lstat(meta)
    if (fileStat.isSymbolicLink()) return false
    if (!fileStat.isFile()) return false
    bytes = await readFile(meta)
  } catch {
    return false
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf-8'))
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const segments = (parsed as Record<string, unknown>).segments
  if (!Array.isArray(segments)) return false
  return true
}

/**
 * Reset the Tantivy index directory to an empty state. Callers run
 * this after the rebuild planner returns `kind: 'full'`: the prior
 * index is unrecoverable, the native writer wants a clean slate, and
 * leaving stale segment files behind would corrupt the freshly built
 * index (the writer cannot reconcile orphaned segments against a new
 * `meta.json`).
 *
 * The reset is filesystem-aware: it never traverses a symlink at the
 * index path (CQ-094-style hardening). A symlinked index dir is a
 * configuration-time integrity failure — recursive removal through
 * the symlink would delete its external target — so this helper
 * throws and leaves the symlink in place for an operator to
 * investigate. The probe already returns `false` for a symlinked
 * index, so the planner already routes to `full`; the writer must
 * surface the deletion failure rather than silently widening the
 * blast radius.
 *
 * Idempotent: when no index directory exists yet (fresh bundle) the
 * helper just creates an empty one. When the path exists as a regular
 * directory, contents are removed recursively and the directory is
 * recreated empty so the writer can open it immediately.
 *
 * Refuses to operate when the path exists as a regular file
 * (something other than the native writer has populated the slot) —
 * the failure mode mirrors the symlink case: the helper does not know
 * how to interpret the stray file and the caller must intervene
 * rather than blindly overwrite.
 *
 * Side effects are confined to `<bundleRoot>/derived/tantivy/index`
 * itself and its descendants; the parent directory is created if
 * missing so a fresh bundle does not trip the writer's open path.
 */
export async function clearTantivyIndexDir(bundleRoot: string): Promise<void> {
  const dir = tantivyIndexDir(bundleRoot)
  let exists = true
  try {
    const dirStat = await lstat(dir)
    if (dirStat.isSymbolicLink()) {
      throw new Error(
        `clearTantivyIndexDir: refusing to clear ${dir} — path is a symlink (CQ-094). Resolve the symlink configuration manually before retrying.`,
      )
    }
    if (!dirStat.isDirectory()) {
      throw new Error(`clearTantivyIndexDir: refusing to clear ${dir} — path exists and is not a directory.`)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      exists = false
    } else {
      throw err
    }
  }
  if (exists) {
    // `rm` with `recursive: true` does NOT follow symlinks: any
    // symlinked children are unlinked in place, not traversed. The
    // symlink-at-root case is already rejected above, so the
    // recursive walk is confined to the bundle.
    await rm(dir, { recursive: true, force: false })
  }
  // Recreate the empty directory so the native writer (and the
  // `tantivyIndexDirIsValid` probe, once the writer drops a fresh
  // `meta.json`) sees a usable surface immediately.
  await mkdir(dir, { recursive: true })
}
