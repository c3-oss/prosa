// Shared containment probe for the SessionBlob derived path chain.
//
// Several SessionBlob filesystem surfaces (`loadSessionBlobPack`,
// `listSessionBlobSessions`, future writer/sweeper) need the same
// CQ-098 guarantee: managed intermediate components inside
// `<bundleRoot>/derived/session-blob/` must not be symlinks. Without
// this, `lstat` of a final pack path resolves through the symlinked
// intermediate transparently and the surface would touch bytes
// outside the bundle.
//
// Bundle-root containment is **not** validated here: opening a bundle
// through a symlinked alias (e.g. `/opt/prosa/current -> /v123`) is
// a supported deployment pattern. The rejection target is symlinks
// inside the managed derived tree.
//
// This helper is the SessionBlob counterpart of
// `detectDerivedTantivyIntermediateSymlink` in
// `../tantivy/index-dir.ts`. The two stay separate because their
// intermediate chains differ (`derived/tantivy` vs
// `derived/session-blob/epoch-<n>`); both share the same lstat +
// outermost-first walk policy and the same bundle-root-alias
// exception.

import { lstat } from 'node:fs/promises'

import { derivedPaths, sessionBlobEpochDir } from '../derived-layout.js'

/**
 * Walk the managed SessionBlob intermediate components outermost →
 * innermost and report the first symlink found. The walk covers
 * `<bundleRoot>/derived`, `<bundleRoot>/derived/session-blob`, and —
 * when `epoch` is supplied — the per-epoch directory
 * `<bundleRoot>/derived/session-blob/epoch-<n>`.
 *
 * Behaviour:
 *
 *   - Returns `{ escape: false }` when every walked component is a
 *     non-symlink (regular dir / regular file / does-not-exist).
 *   - Returns `{ escape: true, path }` on the first symlink hit; the
 *     path is the outermost escape point so error messages point to
 *     the highest source of containment failure.
 *   - ENOENT on any intermediate resolves to `escape: false` (the
 *     caller's outer surface handles missing-final-path with its
 *     own ENOENT path).
 *   - Other I/O errors (EACCES, EIO, ...) propagate so the caller can
 *     surface the underlying failure rather than silently treating it
 *     as "safe".
 *
 * `epoch` is optional: callers that operate on the whole SessionBlob
 * tree (e.g. enumerate all epochs) pass `undefined` to walk only the
 * top two intermediates; callers that operate on a specific epoch
 * (loader, per-epoch listing) pass the integer and pick up the
 * `epoch-<n>` check for free.
 */
export async function detectSessionBlobIntermediateSymlink(
  bundleRoot: string,
  epoch?: number,
): Promise<{ escape: false } | { escape: true; path: string }> {
  const paths = derivedPaths(bundleRoot)
  const chain: string[] = [paths.derived, paths.sessionBlob]
  if (epoch !== undefined) chain.push(sessionBlobEpochDir(bundleRoot, epoch))
  for (const path of chain) {
    try {
      const st = await lstat(path)
      if (st.isSymbolicLink()) return { escape: true, path }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue
      throw err
    }
  }
  return { escape: false }
}
