// SessionBlobPackV2 latest-epoch lookup (no bytes read).
//
// `latestEpochForSession({ bundleRoot, sessionId })` returns the
// newest epoch number that has a pack for the session, or `null`
// when no epoch under the bundle does. Composes
// `listSessionBlobEpochs` (newest → oldest walk) with per-epoch
// `sessionBlobPackExists` probes (each one syscall set: intermediate
// chain + single final `lstat`).
//
// Differs from `loadLatestSessionBlobPack` in two ways:
//
//   1. Returns the epoch identifier only — no header, no bytes,
//      no pack-digest verification. The caller pays for a load
//      only when they want data.
//   2. Returns `null` (not ENOENT) when the session has no pack
//      anywhere. This is a lookup, not a load; the absence answer
//      is a normal result the caller branches on.
//
// Sync input validation (CQ-100 path) runs first: invalid
// `sessionId` throws via `sessionBlobPackPath` before any
// filesystem read.
//
// Use cases:
//
//   - "Should I refresh?" flows that compare a known epoch against
//     the current latest.
//   - Cache-key generation: the epoch number is the version stamp
//     for the session's transcript.
//   - Inventory views that show "newest activity in epoch N" rows
//     without paying for the full header read.

import { sessionBlobPackPath } from '../derived-layout.js'

import { sessionBlobPackExists } from './exists.js'
import { listSessionBlobEpochs } from './listing.js'

export interface LatestEpochForSessionInput {
  /** Absolute bundle root. */
  bundleRoot: string
  /** Canonical session id (validated by `sessionBlobPackPath`). */
  sessionId: string
}

/**
 * Find the newest epoch with a pack for `sessionId`, returning the
 * epoch number (or `null` when no epoch has one).
 *
 * Walks `listSessionBlobEpochs(bundleRoot)` from highest to lowest
 * and uses `sessionBlobPackExists` per epoch as a cheap probe.
 * Per-epoch ENOENT / symlink / non-regular-file outcomes collapse
 * to "skip and try older" inside `sessionBlobPackExists`'s
 * boolean-return contract; the overall function never throws on
 * those negative outcomes. The "no pack anywhere" case resolves
 * to `null`.
 *
 * Synchronous `sessionId` validation runs first via
 * `sessionBlobPackPath` (CQ-100 pattern): invalid input throws
 * before any filesystem read. An unexpected I/O error (EACCES,
 * EIO) during the `listSessionBlobEpochs` call propagates.
 */
export async function latestEpochForSession(input: LatestEpochForSessionInput): Promise<number | null> {
  // CQ-100: validate `sessionId` synchronously before any
  // filesystem read. Without this, an invalid id on a fresh bundle
  // would silently resolve to `null` instead of surfacing the
  // resolver-grammar error. The sentinel `0` epoch drives the
  // path-build; no side effect persists.
  sessionBlobPackPath(input.bundleRoot, input.sessionId, 0)
  const epochs = await listSessionBlobEpochs(input.bundleRoot)
  for (let i = epochs.length - 1; i >= 0; i--) {
    const epoch = epochs[i]!
    if (await sessionBlobPackExists({ bundleRoot: input.bundleRoot, sessionId: input.sessionId, epoch })) {
      return epoch
    }
  }
  return null
}
