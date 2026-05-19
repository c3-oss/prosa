// SessionBlobPackV2 aggregate summary for inventory views.
//
// `getSessionBlobSummary({ bundleRoot, sessionId })` returns a single
// row that combines:
//
//   - the full list of epochs that have a pack for the session;
//   - the latest epoch's pack identity (path, digest);
//   - aggregate counts from the latest epoch's header (message
//     count, page count, ordinal range, turn count, tool-call count).
//
// Returns `null` when no epoch has a pack for the session — same
// "absence is a normal answer" contract as `latestEpochForSession`.
//
// Composes:
//
//   1. `listSessionBlobEpochs` enumerates the epoch directories.
//   2. `sessionBlobPackExists` probes each epoch (cheap `lstat`-only)
//      to record which epochs actually have this session's pack.
//      Per-epoch CQ-094 / CQ-098 / non-regular-file outcomes
//      collapse to "skip this epoch" (the probe returns false).
//   3. `readSessionBlobHeader` is called on the latest epoch only
//      for the aggregate stats — every prior epoch's header is
//      irrelevant because the latest pack carries the up-to-date
//      transcript.
//
// Sync `sessionId` validation runs first via `sessionBlobPackPath`
// (CQ-100 pattern): invalid input throws before any filesystem read.
//
// Use case: MCP `list_sessions` row shape, CLI inventory listings,
// web dashboards. The caller does not need to compose three
// surfaces per row.

import { sessionBlobPackPath } from '../derived-layout.js'

import { sessionBlobPackExists } from './exists.js'
import { readSessionBlobHeader } from './header.js'
import { listSessionBlobEpochs } from './listing.js'

export interface GetSessionBlobSummaryInput {
  /** Absolute bundle root. */
  bundleRoot: string
  /** Canonical session id (validated by `sessionBlobPackPath`). */
  sessionId: string
}

export interface SessionBlobSummary {
  /** Echoed session id, suitable for round-tripping through
   *  `sessionBlobPackPath` again (the input was already validated
   *  before we reached this point). */
  session_id: string
  /** Every epoch under the bundle that has a pack for this session,
   *  sorted ascending. The last entry is the latest epoch. */
  epochs: number[]
  /** Newest epoch with a pack for this session — convenience getter
   *  for `epochs.at(-1)`. */
  latest_epoch: number
  /** Resolved on-disk path of the latest pack. */
  latest_path: string
  /** Pack digest of the latest pack, re-verified from the bytes. */
  latest_pack_digest: string
  /** Latest pack's `page_count` (from the header — no decompression
   *  happens). */
  page_count: number
  /** Sum of `message_count` across the latest pack's pages. */
  message_count: number
  /** Sum of `turn_count` across the latest pack's pages. */
  turn_count: number
  /** Sum of `tool_call_count` across the latest pack's pages. */
  tool_call_count: number
  /** Lowest `message_ordinal_start` across the latest pack's pages.
   *  `null` when the latest pack has zero pages (empty session). */
  ordinal_start: number | null
  /** Highest `message_ordinal_end` across the latest pack's pages.
   *  `null` when the latest pack has zero pages (empty session). */
  ordinal_end: number | null
}

/**
 * One-call inventory-row summary for a session. Returns the per-
 * session shape MCP / CLI / web inventory views want without forcing
 * the caller to compose `listSessionBlobEpochs` + per-epoch
 * `sessionBlobPackExists` + `readSessionBlobHeader` themselves.
 *
 * Returns `null` when no epoch contains a pack for the session.
 * Throws on invalid `sessionId` synchronously and on CQ-098 parent-
 * symlink rejection from `listSessionBlobEpochs`. Per-epoch
 * CQ-094/CQ-098/non-regular-file outcomes collapse to "skip this
 * epoch" inside the existence probe.
 *
 * `readSessionBlobHeader` is called exactly once (for the latest
 * epoch) — the per-page aggregates come from the header, no page
 * is decompressed.
 */
export async function getSessionBlobSummary(input: GetSessionBlobSummaryInput): Promise<SessionBlobSummary | null> {
  // CQ-100: synchronous `sessionId` validation before any filesystem
  // read. The sentinel `0` epoch drives the path-build; no side
  // effect persists.
  sessionBlobPackPath(input.bundleRoot, input.sessionId, 0)
  const candidateEpochs = await listSessionBlobEpochs(input.bundleRoot)
  const epochs: number[] = []
  for (const epoch of candidateEpochs) {
    if (await sessionBlobPackExists({ bundleRoot: input.bundleRoot, sessionId: input.sessionId, epoch })) {
      epochs.push(epoch)
    }
  }
  if (epochs.length === 0) return null
  const latestEpoch = epochs[epochs.length - 1]!
  const head = await readSessionBlobHeader({
    bundleRoot: input.bundleRoot,
    sessionId: input.sessionId,
    epoch: latestEpoch,
  })
  let messageCount = 0
  let turnCount = 0
  let toolCallCount = 0
  let ordinalStart: number | null = null
  let ordinalEnd: number | null = null
  for (const page of head.header.pages) {
    messageCount += page.message_count
    turnCount += page.turn_count
    toolCallCount += page.tool_call_count
    if (ordinalStart === null || page.message_ordinal_start < ordinalStart) {
      ordinalStart = page.message_ordinal_start
    }
    if (ordinalEnd === null || page.message_ordinal_end > ordinalEnd) {
      ordinalEnd = page.message_ordinal_end
    }
  }
  return {
    session_id: input.sessionId,
    epochs,
    latest_epoch: latestEpoch,
    latest_path: head.path,
    latest_pack_digest: head.pack_digest,
    page_count: head.header.page_count,
    message_count: messageCount,
    turn_count: turnCount,
    tool_call_count: toolCallCount,
    ordinal_start: ordinalStart,
    ordinal_end: ordinalEnd,
  }
}
