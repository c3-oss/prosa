// Bundle-wide SessionBlob pack verifier.
//
// Walks every `(session_id, epoch)` pair under
// `<bundleRoot>/derived/session-blob/` and runs the same pack-digest
// verification as `loadSessionBlobPack`. Errors are captured into a
// `failed` array instead of throwing, so a single corrupted pack
// does not stop the audit. Callers can decide whether to exit
// non-zero based on `failed.length > 0`.
//
// Pure-read — no filesystem mutation. Containment + sync sessionId
// validation inherit from `listSessionBlobEpochs` /
// `listSessionBlobSessions` / `loadSessionBlobPack`; a CQ-098
// intermediate-symlink violation throws *before* any pack is read
// because the parent listing throws unconditionally.

import { listSessionBlobEpochs, listSessionBlobSessions } from './listing.js'
import { loadSessionBlobPack } from './loader.js'

export interface VerifyAllSessionBlobPacksResult {
  /** One row per pack that was successfully read and whose
   *  `verifyPackDigest` matched the stored digest. */
  verified: Array<{
    session_id: string
    epoch: number
    path: string
    pack_digest: string
  }>
  /** One row per pack that failed to load or verify. `error` is the
   *  stringified message from the loader; the path is populated when
   *  we know what the loader was trying to read. */
  failed: Array<{
    session_id: string
    epoch: number
    error: string
  }>
}

/**
 * Verify every SessionBlob pack in the bundle. Walks
 * `listSessionBlobEpochs(bundleRoot)` then
 * `listSessionBlobSessions({ bundleRoot, epoch })` per epoch,
 * calling `loadSessionBlobPack` for each `(session_id, epoch)`
 * pair. Each successful load already runs `verifyPackDigest`
 * (tamper detection) — the walker just records the outcome.
 *
 * Results:
 *
 *   - `verified[]` — successful reads, sorted by `(epoch,
 *     session_id)` ascending (the listing's natural order).
 *   - `failed[]` — captured errors. Same sort.
 *
 * Use cases:
 *
 *   - `prosa index-v2 verify-packs` CLI for bundle integrity audits.
 *   - Pre-promotion checks that surface corruption before
 *     remote-authoritative reads start pinning the bytes.
 *
 * Empty bundle (no SessionBlob epochs / no packs) returns
 * `{ verified: [], failed: [] }`. Symlinked managed intermediates
 * (`derived` / `derived/session-blob` / `epoch-<n>`) propagate the
 * CQ-098 throw from the listing helper without being captured —
 * containment errors are setup mistakes, not per-pack corruption.
 */
export async function verifyAllSessionBlobPacks(bundleRoot: string): Promise<VerifyAllSessionBlobPacksResult> {
  const verified: VerifyAllSessionBlobPacksResult['verified'] = []
  const failed: VerifyAllSessionBlobPacksResult['failed'] = []

  const epochs = await listSessionBlobEpochs(bundleRoot)
  for (const epoch of epochs) {
    const sessionIds = await listSessionBlobSessions({ bundleRoot, epoch })
    for (const sessionId of sessionIds) {
      try {
        const pack = await loadSessionBlobPack({ bundleRoot, sessionId, epoch })
        verified.push({ session_id: sessionId, epoch, path: pack.path, pack_digest: pack.pack_digest })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failed.push({ session_id: sessionId, epoch, error: message })
      }
    }
  }

  return { verified, failed }
}
