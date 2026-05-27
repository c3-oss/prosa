// SessionBlobPackV2 cheap existence probe.
//
// `sessionBlobPackExists({ bundleRoot, sessionId, epoch })` answers
// "is there a real (non-symlinked, non-directory) pack file for this
// session in this epoch?" without reading any bytes or verifying the
// pack digest. Mirrors `tantivyIndexDirIsValid`'s "return false on
// any negative outcome" policy so callers can use it as a true
// pre-flight check before paying for the full loader.
//
// Why not just call `loadSessionBlobPack` in a try/catch? The loader
// reads the whole pack file and re-derives `pack_digest` from the
// bytes — that's the right cost for a load, but overkill when the
// caller only wants to know "is this worth attempting?". The probe
// `lstat`s the final path (cheap, single syscall) and walks the
// intermediate symlink check (no I/O beyond the same `lstat`s the
// loader would do).
//
// Negative outcomes that yield `false`:
//
//   - ENOENT at any intermediate or the final pack path;
//   - symlink at any managed intermediate (CQ-098) or the final
//     `<session_id>.pack` (CQ-094);
//   - non-regular-file at the pack path (directory, socket, ...).
//
// Inputs are still validated synchronously via `sessionBlobPackPath`
// (CQ-099 grammar): invalid `sessionId` / `epoch` throw before any
// filesystem touch. A probe should distinguish "the input is
// malformed" from "the input is well-formed but the artifact is
// absent" — silently returning `false` for invalid input would
// swallow programmer errors.

import { lstat } from 'node:fs/promises'

import { sessionBlobPackPath } from '../derived-layout.js'

import { detectSessionBlobIntermediateSymlink } from './containment.js'

export interface SessionBlobPackExistsInput {
  /** Absolute bundle root. */
  bundleRoot: string
  /** Canonical session id (validated by `sessionBlobPackPath`). */
  sessionId: string
  /** Non-negative safe-integer epoch (validated by
   *  `sessionBlobPackPath`). */
  epoch: number
}

/**
 * Cheap pre-flight probe: returns `true` iff a SessionBlobPackV2
 * pack file exists at the canonical path for `(bundleRoot, sessionId,
 * epoch)` as a real regular file with no symlinks in the managed
 * derived chain. Returns `false` on ENOENT, symlinks at any managed
 * component (CQ-094 / CQ-098), non-regular-files, or any other I/O
 * failure during the probe.
 *
 * Synchronous input validation (grammar / range checks for
 * `sessionId` / `epoch`) still throws via `sessionBlobPackPath` —
 * the probe answers presence, not correctness.
 *
 * No bytes are read; no digest is verified. The caller is responsible
 * for invoking the full `loadSessionBlobPack` (or a header-only
 * reader) when actual data is needed.
 */
export async function sessionBlobPackExists(input: SessionBlobPackExistsInput): Promise<boolean> {
  // Validate inputs (throws on invalid id/epoch); the path is built
  // for the lstat below.
  const path = sessionBlobPackPath(input.bundleRoot, input.sessionId, input.epoch)
  try {
    const intermediate = await detectSessionBlobIntermediateSymlink(input.bundleRoot, input.epoch)
    if (intermediate.escape) return false
  } catch {
    return false
  }
  try {
    const st = await lstat(path)
    if (st.isSymbolicLink()) return false
    if (!st.isFile()) return false
    return true
  } catch {
    return false
  }
}
