// SessionBlobPackV2 header-only reader.
//
// `readSessionBlobHeader({ bundleRoot, sessionId, epoch? })` returns
// just the parsed `SessionBlobPackHeaderV2` (page count, per-page
// ordinal ranges, pack digest, compression) without decompressing
// any page body. Pairs with the listing helpers for inventory views
// that show "session X has N messages across K pages, ordinal range
// 0..N-1" — the per-page ranges and counts come straight from the
// header, so no decompressor is needed at all.
//
// Epoch resolution:
//
//   - `epoch` supplied → reads that specific pack via
//     `loadSessionBlobPack` (full pack-digest verification +
//     containment + CQ-094/CQ-098 symlink refusal + non-regular-file
//     refusal).
//   - `epoch` omitted → finds the newest epoch that has a pack for
//     the session via `loadLatestSessionBlobPack` (same guarantees
//     plus the latest-epoch walk).
//
// Both paths re-verify `pack_digest` from the bytes alone, so the
// returned header has been validated as authentic before it leaves
// the function. The function still has to read the whole pack file
// (page payload is contiguous in the framed bytes) but does NOT
// decompress any page — bytes go in, header comes out.
//
// Use case: CLI / MCP / web list views that render "N messages, K
// pages, last activity at <timestamp>" rows for many sessions
// without paying decompression cost per row.

import type { SessionBlobPackHeaderV2 } from './types.js'

import { loadLatestSessionBlobPack } from './latest.js'
import { loadSessionBlobPack } from './loader.js'

export interface ReadSessionBlobHeaderInput {
  /** Absolute bundle root. */
  bundleRoot: string
  /** Canonical session id (validated by `sessionBlobPackPath` via
   *  the composed loader; same grammar as the resolver). */
  sessionId: string
  /** Optional non-negative safe-integer epoch. When omitted, reads
   *  the newest epoch's header via `loadLatestSessionBlobPack`. */
  epoch?: number
}

export interface ReadSessionBlobHeaderResult {
  /** Epoch the header came from. Equals the caller-supplied epoch
   *  when given; otherwise the newest epoch with a pack for this
   *  session. */
  epoch: number
  /** Resolved on-disk pack path. */
  path: string
  /** Pack digest recomputed from the bytes alone. */
  pack_digest: string
  /** Parsed canonical-JSON header: `pack_digest`, `compression`,
   *  `epoch`, `page_count`, `pages[]` (with per-page ordinal range,
   *  message/turn/tool-call counts, stored / uncompressed lengths,
   *  stored / uncompressed hashes). */
  header: SessionBlobPackHeaderV2
}

/**
 * Read just the SessionBlobPackV2 header for a session — no page
 * decompression. Same surface as the full loaders
 * (`{ epoch, path, pack_digest, header }`) but the result intentionally
 * does NOT carry the page bytes or transcript messages.
 *
 * Use when:
 *
 *   - Building inventory listings ("session X: N messages, K pages,
 *     newest epoch 5") that paint many rows;
 *   - Computing summary stats (turn count, tool-call count) that the
 *     header pre-aggregates per page;
 *   - Checking pack identity (`pack_digest`) before deciding whether
 *     to re-fetch the full bytes.
 *
 * Failure semantics, validation, containment, and tamper detection
 * are inherited from the composed loader:
 *
 *   - Missing pack (epoch supplied but no `<session_id>.pack` there):
 *     ENOENT.
 *   - No pack in any epoch (`epoch` omitted, session never written):
 *     synthetic ENOENT from `loadLatestSessionBlobPack`.
 *   - CQ-094 final-component / CQ-098 intermediate symlink refusals
 *     propagate.
 *   - `verifyPackDigest` mismatch (tampered bytes) propagates.
 *   - Synchronous `sessionId` / `epoch` validation (CQ-100 path) runs
 *     before any filesystem read.
 */
export async function readSessionBlobHeader(input: ReadSessionBlobHeaderInput): Promise<ReadSessionBlobHeaderResult> {
  if (input.epoch === undefined) {
    const pack = await loadLatestSessionBlobPack({
      bundleRoot: input.bundleRoot,
      sessionId: input.sessionId,
    })
    return {
      epoch: pack.epoch,
      path: pack.path,
      pack_digest: pack.pack_digest,
      header: pack.header,
    }
  }
  const pack = await loadSessionBlobPack({
    bundleRoot: input.bundleRoot,
    sessionId: input.sessionId,
    epoch: input.epoch,
  })
  return {
    epoch: input.epoch,
    path: pack.path,
    pack_digest: pack.pack_digest,
    header: pack.header,
  }
}
