// SessionBlobPackV2 "latest epoch" loader.
//
// `loadLatestSessionBlobPack({ bundleRoot, sessionId })` answers the
// most common read-path question for CLI/MCP/web surfaces: "give me
// this session's transcript without me having to know which epoch
// last touched it." It walks the epochs reported by
// `listSessionBlobEpochs` newest-first, calls `loadSessionBlobPack`
// for each, returns the first successful load (with the epoch number
// the pack came from), and throws an ENOENT-coded error only when no
// epoch under the bundle contains a pack for the requested session.
//
// Containment + tamper + input validation are all delegated:
//
//   - `listSessionBlobEpochs` enforces the CQ-098 intermediate-symlink
//     check on the SessionBlob parent. A symlinked managed
//     intermediate makes the listing throw before any per-epoch
//     attempt; the error bubbles up unchanged.
//   - `loadSessionBlobPack` re-runs the intermediate check per epoch
//     (the per-epoch dir is part of its chain) plus CQ-094
//     final-component symlink refusal, non-regular-file refusal, and
//     `verifyPackDigest` tamper detection. Any of those failures
//     propagates immediately so the caller can distinguish "no pack
//     for this session" from "the pack we found is broken".
//   - `sessionId` validation is delegated to `sessionBlobPackPath` via
//     the first per-epoch call; an invalid id throws synchronously
//     before any filesystem touch beyond the (cheap) listing.
//
// Selection policy: newest epoch wins. Pack-per-session-per-epoch
// means an older epoch may carry an outdated copy if the session
// reappeared in a later epoch's projection; returning the highest
// epoch with a pack is the canonical "latest" semantic. Holes in the
// epoch sequence are tolerated — the loop only counts epochs the
// `listSessionBlobEpochs` listing already accepted.

import { sessionBlobPackPath } from '../derived-layout.js'

import { listSessionBlobEpochs } from './listing.js'
import { type LoadedSessionBlobPack, loadSessionBlobPack } from './loader.js'

export interface LoadLatestSessionBlobPackInput {
  /** Absolute bundle root. */
  bundleRoot: string
  /** Canonical session ID (validated by `sessionBlobPackPath` via the
   *  first per-epoch `loadSessionBlobPack` call). */
  sessionId: string
}

export interface LoadedLatestSessionBlobPack extends LoadedSessionBlobPack {
  /** Epoch number the returned pack came from. Always one of the
   *  values reported by `listSessionBlobEpochs(bundleRoot)`. */
  epoch: number
}

/**
 * Load the SessionBlobPackV2 pack for a session from its newest epoch.
 *
 * Walks `listSessionBlobEpochs(bundleRoot)` in descending order,
 * attempts `loadSessionBlobPack({ bundleRoot, sessionId, epoch })` for
 * each, and returns the first successful load. ENOENT at a given
 * epoch (no pack for this session in that epoch) is treated as a
 * skip; every other failure propagates immediately so corruption,
 * symlink violations, and tamper detections are not masked by the
 * fallback walk.
 *
 * Throws with `code: 'ENOENT'` when no epoch under the bundle
 * contains a pack for the requested session — including the
 * fresh-bundle case where `listSessionBlobEpochs` returns `[]`.
 * Callers can distinguish "session never written" from "session pack
 * corrupted" by the error code.
 */
export async function loadLatestSessionBlobPack(
  input: LoadLatestSessionBlobPackInput,
): Promise<LoadedLatestSessionBlobPack> {
  // CQ-100: validate `sessionId` synchronously before any
  // filesystem read. Without this, an invalid id paired with a
  // fresh bundle would surface as a synthetic ENOENT ("no pack
  // found across 0 epochs") instead of the precise resolver-grammar
  // error, hiding the real fault from callers. `sessionBlobPackPath`
  // is pure and validates both `sessionId` and the integer-shape of
  // `epoch`; we pass a sentinel `0` epoch to exercise the path-build
  // and surface the validation error. The epoch listing run after
  // this point only sees inputs the resolver has already accepted.
  sessionBlobPackPath(input.bundleRoot, input.sessionId, 0)
  const epochs = await listSessionBlobEpochs(input.bundleRoot)
  for (let i = epochs.length - 1; i >= 0; i--) {
    const epoch = epochs[i]!
    try {
      const loaded = await loadSessionBlobPack({
        bundleRoot: input.bundleRoot,
        sessionId: input.sessionId,
        epoch,
      })
      return { ...loaded, epoch }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue
      throw err
    }
  }
  const err = new Error(
    `loadLatestSessionBlobPack: no pack found for session ${JSON.stringify(
      input.sessionId,
    )} across ${epochs.length} epochs under ${input.bundleRoot}`,
  ) as Error & { code?: string }
  err.code = 'ENOENT'
  throw err
}
