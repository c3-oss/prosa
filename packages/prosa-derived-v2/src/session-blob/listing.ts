// SessionBlobPackV2 directory listings.
//
// Two surfaces:
//
//   - `listSessionBlobEpochs(bundleRoot)` enumerates the epoch numbers
//     present under `<bundleRoot>/derived/session-blob/`. Future
//     analytics rebuilds, cross-epoch transcript walks, and
//     migration code call this to find the set of epochs the
//     SessionBlob writer has emitted packs for.
//
//   - `listSessionBlobSessions({ bundleRoot, epoch })` enumerates the
//     `session_id` values that have a `<session_id>.pack` regular
//     file inside `<bundleRoot>/derived/session-blob/epoch-<n>/`.
//     Callers chain this with `loadSessionBlobPack` to materialise a
//     whole epoch's session set.
//
// Filesystem hardening:
//
//   - Both surfaces reuse the CQ-098 intermediate-symlink probe in
//     `./containment.js`. A symlinked managed intermediate
//     (`derived`, `derived/session-blob`, `derived/session-blob/epoch-<n>`)
//     throws before any listing happens, so the helpers cannot
//     enumerate or return paths outside the bundle.
//
//   - `readdir({ withFileTypes: true })` returns `Dirent` entries that
//     report the entry type as recorded in the directory (no symlink
//     traversal). Per-entry filters reject anything that is not a
//     regular file (sessions) or a regular directory (epochs); a
//     planted symlink under either parent is dropped from the result
//     without throwing — the listing surface is descriptive, not
//     destructive, so the safe behaviour is "ignore the entry" rather
//     than "fail the whole listing".
//
//   - Both surfaces resolve to an empty array on ENOENT (fresh bundle
//     / never-written epoch). Other I/O errors propagate.
//
// Results are sorted ascending and deduplicated so callers can rely on
// deterministic ordering.

import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'

import { derivedPaths, sessionBlobEpochDir, sessionBlobPackPath } from '../derived-layout.js'

import { detectSessionBlobIntermediateSymlink } from './containment.js'

/** Regex matching `epoch-<n>` directory names where `<n>` is a
 *  non-negative integer literal with no leading zero (except for
 *  `epoch-0` itself). Anything else — `epoch-`, `epoch-x`,
 *  `epoch-01`, `epoch-3.5` — is silently ignored so accidental
 *  detritus under the parent does not poison the listing. */
const EPOCH_DIR_PATTERN = /^epoch-(0|[1-9][0-9]*)$/

/** Regex matching `<session_id>.pack` filenames. The session-id
 *  grammar mirrors `sessionBlobPackPath`'s allow-list
 *  (`[A-Za-z0-9_\-:.]{1,200}`) so listings cannot surface filenames
 *  that the resolver would reject if a caller fed them back in. */
const SESSION_PACK_PATTERN = /^([A-Za-z0-9_\-:.]{1,200})\.pack$/

/**
 * Enumerate the epoch numbers that have a `<bundleRoot>/derived/session-blob/epoch-<n>/`
 * directory. Returns a sorted ascending array of unique non-negative
 * integers; an unset session-blob tree (ENOENT) yields `[]`.
 *
 * The walk uses `readdir({ withFileTypes: true })` so symlinked
 * entries are detected without traversal; any symlink under
 * `derived/session-blob/` is silently dropped — the rejection target
 * is path-traversal, not housekeeping clutter. A symlink **at**
 * `derived/session-blob` itself (or at `derived`) throws via the
 * shared CQ-098 containment probe before the listing runs.
 */
export async function listSessionBlobEpochs(bundleRoot: string): Promise<number[]> {
  const intermediate = await detectSessionBlobIntermediateSymlink(bundleRoot)
  if (intermediate.escape) {
    throw new Error(
      `listSessionBlobEpochs: refusing to enumerate — intermediate path ${intermediate.path} is a symlink (CQ-098). Resolve the symlink configuration manually before retrying.`,
    )
  }
  const parent = derivedPaths(bundleRoot).sessionBlob
  let entries: Dirent[]
  try {
    entries = await readdir(parent, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw err
  }
  const epochs = new Set<number>()
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const m = EPOCH_DIR_PATTERN.exec(entry.name)
    if (!m) continue
    const n = Number(m[1])
    if (!Number.isSafeInteger(n) || n < 0) continue
    epochs.add(n)
  }
  return [...epochs].sort((a, b) => a - b)
}

export interface ListSessionBlobSessionsInput {
  /** Absolute bundle root. */
  bundleRoot: string
  /** Non-negative safe-integer epoch. */
  epoch: number
}

/**
 * Enumerate the `session_id` values present in
 * `<bundleRoot>/derived/session-blob/epoch-<n>/` as regular `.pack`
 * files. Returns a sorted ascending array of unique session ids; an
 * empty / missing epoch directory yields `[]`.
 *
 * Per-entry rules:
 *
 *   - Regular files matching the `<session_id>.pack` pattern with a
 *     conformant session-id grammar are returned (`session_id`
 *     without the `.pack` suffix).
 *   - Symlinked entries are dropped. The on-disk writer materialises
 *     real files; a planted symlink to an external pack would let
 *     `loadSessionBlobPack` follow the link via the directory
 *     listing, so the listing surface filters them out at source.
 *   - Non-files (subdirectories, sockets, etc.) and files with
 *     non-conformant names are dropped silently.
 *
 * `epoch` is validated by `sessionBlobEpochDir` (non-negative safe
 * integer); invalid input throws synchronously before any
 * filesystem read.
 */
export async function listSessionBlobSessions(input: ListSessionBlobSessionsInput): Promise<string[]> {
  const intermediate = await detectSessionBlobIntermediateSymlink(input.bundleRoot, input.epoch)
  if (intermediate.escape) {
    throw new Error(
      `listSessionBlobSessions: refusing to enumerate — intermediate path ${intermediate.path} is a symlink (CQ-098). Resolve the symlink configuration manually before retrying.`,
    )
  }
  const dir = sessionBlobEpochDir(input.bundleRoot, input.epoch)
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw err
  }
  const sessions = new Set<string>()
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue
    const m = SESSION_PACK_PATTERN.exec(entry.name)
    if (!m) continue
    const candidate = m[1]!
    // CQ-099: defer to `sessionBlobPackPath`'s validation so the
    // listing surface never returns an id the resolver would reject.
    // Catches reserved values (`.` / `..`), `..` substrings, and any
    // future tightening of the session-id grammar without needing a
    // matching change here. `sessionBlobPackPath` is pure: it does
    // not touch the filesystem; the call is cheap.
    try {
      sessionBlobPackPath(input.bundleRoot, candidate, input.epoch)
    } catch {
      continue
    }
    sessions.add(candidate)
  }
  return [...sessions].sort()
}

/**
 * Cross-epoch enumeration: returns the sorted ascending set of unique
 * session ids that have a pack in any epoch under
 * `<bundleRoot>/derived/session-blob/`. Composes
 * `listSessionBlobEpochs` with a per-epoch `listSessionBlobSessions`
 * union; the result is the deduplicated set across every epoch the
 * SessionBlob writer has emitted to.
 *
 * Pairs naturally with `loadLatestSessionBlobPack` for "list every
 * session in this bundle, then render each one's latest transcript"
 * workflows (CLI inventory commands, MCP `list_sessions`, web
 * dashboards).
 *
 * Containment + per-entry symlink + resolver-parity guarantees are
 * inherited from `listSessionBlobEpochs` (CQ-098 parent check) +
 * `listSessionBlobSessions` (CQ-098 per-epoch check, per-entry
 * symlink drop, CQ-099 resolver-parity). A symlinked managed
 * intermediate at the parent throws before any per-epoch walk;
 * a per-epoch symlink violation throws and aborts the union build.
 *
 * Fresh bundle (no epochs) yields `[]`. Empty epoch directories
 * contribute nothing. Sessions appearing in multiple epochs surface
 * exactly once.
 */
export async function listAllSessionBlobSessions(bundleRoot: string): Promise<string[]> {
  const epochs = await listSessionBlobEpochs(bundleRoot)
  const sessions = new Set<string>()
  for (const epoch of epochs) {
    const perEpoch = await listSessionBlobSessions({ bundleRoot, epoch })
    for (const id of perEpoch) sessions.add(id)
  }
  return [...sessions].sort()
}
