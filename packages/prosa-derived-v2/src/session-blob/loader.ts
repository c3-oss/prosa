// SessionBlobPackV2 on-disk loader.
//
// `loadSessionBlobPack({ bundleRoot, sessionId, epoch })` resolves the
// canonical pack path via `sessionBlobPackPath`, reads the bytes,
// re-verifies the `pack_digest` from the bytes alone (so the header
// field is never trusted), and returns the decoded header + per-page
// slices. The decoded result composes with `loadTranscriptPage` and
// `iterateTranscript` from `./reader.js`.
//
// Filesystem hardening mirrors the Tantivy CQ-094 contract: the pack
// path is `lstat`ed and a symlink at the final component is rejected
// unconditionally. A future writer must materialise packs as regular
// files within the managed `<bundleRoot>/derived/session-blob/`
// subtree; an external-target symlink would otherwise let the loader
// read bytes outside the bundle.
//
// CQ-098: the same symlink-rejection contract extends to managed
// intermediate components (`<bundleRoot>/derived`,
// `<bundleRoot>/derived/session-blob`, and
// `<bundleRoot>/derived/session-blob/epoch-<n>`). Without the
// intermediate check, a symlink at any of those positions would let
// `lstat(packPath)` observe an external pack file and the loader would
// read bytes outside the bundle. The bundle root itself is NOT
// validated: opening the bundle through a symlinked alias is a
// supported deployment pattern. Mirrors the CQ-096 fix for the Tantivy
// derived path chain.
//
// Input validation (sessionId grammar, epoch range) is delegated to
// `sessionBlobPackPath` which throws on invalid inputs.

import { lstat, readFile } from 'node:fs/promises'

import { derivedPaths, sessionBlobEpochDir, sessionBlobPackPath } from '../derived-layout.js'

import { type DecodedSessionBlobPack, decodeSessionBlobPack, verifyPackDigest } from './reader.js'

/**
 * CQ-098 containment probe for the SessionBlob loader path chain.
 * Walks the managed intermediate components outermost → innermost
 * (`derived`, `derived/session-blob`, `derived/session-blob/epoch-<n>`)
 * and reports the first symlink found. Mirrors the CQ-096 Tantivy
 * helper in shape and policy:
 *
 *   - Missing intermediates resolve to `escape: false` (the outer
 *     `lstat(packPath)` will surface a clean ENOENT for the caller).
 *   - A non-symlink intermediate (regular dir / file) is fine here;
 *     the outer `lstat(packPath)` handles non-directory-at-pack-path.
 *   - Order matters: outermost first, so the error message names the
 *     highest escape point (most useful operator signal).
 */
async function detectSessionBlobIntermediateSymlink(
  bundleRoot: string,
  epoch: number,
): Promise<{ escape: false } | { escape: true; path: string }> {
  const paths = derivedPaths(bundleRoot)
  const epochDir = sessionBlobEpochDir(bundleRoot, epoch)
  for (const path of [paths.derived, paths.sessionBlob, epochDir]) {
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

export interface LoadSessionBlobPackInput {
  /** Absolute bundle root. */
  bundleRoot: string
  /** Canonical session ID (validated by `sessionBlobPackPath`). */
  sessionId: string
  /** Non-negative safe-integer epoch (validated by `sessionBlobPackPath`). */
  epoch: number
}

export interface LoadedSessionBlobPack extends DecodedSessionBlobPack {
  /** Resolved on-disk path of the pack. */
  path: string
  /** Raw pack bytes (callers can pass these to `loadTranscriptPage` /
   *  `iterateTranscript` without re-reading). */
  bytes: Uint8Array
  /** Pack digest recomputed from the bytes alone (matches
   *  `header.pack_digest` after `verifyPackDigest` returns). */
  pack_digest: string
}

/**
 * Read and verify the SessionBlobPackV2 pack for a `(sessionId,
 * epoch)` pair. Throws when:
 *
 *   - `sessionId` or `epoch` fail `sessionBlobPackPath` validation
 *     (delegated; same traversal-prevention guarantees);
 *   - the pack file does not exist (ENOENT propagates so callers can
 *     distinguish "no pack for this epoch" from corruption);
 *   - the path resolves to a symlink (CQ-094 hardening — the writer
 *     materialises real files; a planted symlink would let the
 *     loader follow an external target);
 *   - the path is not a regular file (e.g. a directory planted at
 *     the pack path);
 *   - `verifyPackDigest` recomputes a digest that does not match the
 *     `pack_digest` claimed by the header (tamper detection).
 *
 * The header field is re-derived from the bytes; the loader returns
 * the recomputed digest in `pack_digest`. Decoding is performed
 * exactly once; callers receive `pageBytes` slices ready to hand to
 * `loadTranscriptPage` or `iterateTranscript`.
 */
export async function loadSessionBlobPack(input: LoadSessionBlobPackInput): Promise<LoadedSessionBlobPack> {
  const path = sessionBlobPackPath(input.bundleRoot, input.sessionId, input.epoch)
  // CQ-098: refuse to read when any managed intermediate component
  // (`derived`, `derived/session-blob`, `derived/session-blob/epoch-<n>`)
  // is a symlink. Without this, `lstat(packPath)` could observe a
  // pack file outside the bundle and the loader would happily read +
  // verify it.
  const intermediate = await detectSessionBlobIntermediateSymlink(input.bundleRoot, input.epoch)
  if (intermediate.escape) {
    throw new Error(
      `loadSessionBlobPack: refusing to read ${path} — intermediate path ${intermediate.path} is a symlink (CQ-098). Resolve the symlink configuration manually before retrying.`,
    )
  }
  const st = await lstat(path)
  if (st.isSymbolicLink()) {
    throw new Error(`loadSessionBlobPack: refusing to read ${path} — path is a symlink (CQ-094).`)
  }
  if (!st.isFile()) {
    throw new Error(`loadSessionBlobPack: refusing to read ${path} — path is not a regular file.`)
  }
  const bytes = new Uint8Array(await readFile(path))
  const packDigest = verifyPackDigest(bytes)
  const decoded = decodeSessionBlobPack(bytes)
  return {
    header: decoded.header,
    pageBytes: decoded.pageBytes,
    path,
    bytes,
    pack_digest: packDigest,
  }
}
