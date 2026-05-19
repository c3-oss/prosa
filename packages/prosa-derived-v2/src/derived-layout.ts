// Derived-layer on-disk directory layout helpers.
//
// Mirrors the bundle-v2 `bundlePaths(root)` pattern so every derived
// artifact has one source of truth for its on-disk location. The
// existing per-feature path getters (`tantivyIndexDir`,
// `tantivyMetaPath`, `tantivyCheckpointPath`) all build paths under
// `<bundleRoot>/derived/`, but they each hardcode the relative
// segment. Centralising the layout here lets future surfaces (session
// blob packs, analytics work directories, runtime Parquet merge
// outputs) reuse the same root without re-deriving it.
//
// This module is path-only: it does not touch the filesystem, does
// not create any directories, and does not enforce that the paths
// exist. Probe helpers (e.g. `tantivyIndexDirIsValid`) remain in
// their feature modules; this layout is the "where", not the
// "is it valid?".
//
// SessionBlobPackV2 on-disk layout (per lean-profile lane-3 doc:
// "one pack per session per epoch"): packs live at
// `<bundleRoot>/derived/session-blob/epoch-<n>/<session_id>.pack`.
// The epoch dir mirrors bundle-v2's `epochs/<n>/` grouping so cheap
// per-epoch operations (purge, list, rebuild) stay symmetric with the
// canonical bundle layout, and the `.pack` suffix matches
// `cas/packs/*.pack`. `sessionBlobPackPath` validates inputs to
// prevent path-traversal injection through `sessionId` or `epoch`.

import { join } from 'node:path'

/** Typed bundle-derived directory layout. Mirrors the shape of
 *  `BundlePaths` from `@c3-oss/prosa-bundle-v2`. */
export interface DerivedPaths {
  /** Bundle root (passed through verbatim for callers that pass the
   *  whole object around). */
  root: string
  /** `<bundleRoot>/derived` — the top-level derived directory. */
  derived: string
  /** `<bundleRoot>/derived/tantivy` — Tantivy parent directory holding
   *  the index, checkpoint, and any future generation-tracking
   *  metadata. */
  tantivy: string
  /** `<bundleRoot>/derived/tantivy/index` — Tantivy native index
   *  directory. Owned by the native writer once it lands. */
  tantivyIndex: string
  /** `<bundleRoot>/derived/tantivy/index/meta.json` — Tantivy manifest
   *  the index-dir probe parses. */
  tantivyMeta: string
  /** `<bundleRoot>/derived/tantivy/checkpoint.json` — rebuild-planner
   *  IndexCheckpointV2 persistence target. */
  tantivyCheckpoint: string
  /** `<bundleRoot>/derived/session-blob` — SessionBlobPackV2 parent
   *  directory. Per-epoch subdirectories live below this path. */
  sessionBlob: string
  /** `<bundleRoot>/derived/analytics` — analytics workspace (DuckDB
   *  scratch, materialised reports). Owned by the future analytics
   *  runtime executor. */
  analytics: string
}

/** Build the typed layout from a bundle root. Pure function — does
 *  not touch the filesystem. */
export function derivedPaths(root: string): DerivedPaths {
  const derived = join(root, 'derived')
  const tantivy = join(derived, 'tantivy')
  const tantivyIndex = join(tantivy, 'index')
  return {
    root,
    derived,
    tantivy,
    tantivyIndex,
    tantivyMeta: join(tantivyIndex, 'meta.json'),
    tantivyCheckpoint: join(tantivy, 'checkpoint.json'),
    sessionBlob: join(derived, 'session-blob'),
    analytics: join(derived, 'analytics'),
  }
}

/** `<bundleRoot>/derived`. Convenience for callers that only need the
 *  top-level root and want to avoid building the full `DerivedPaths`. */
export function derivedRoot(root: string): string {
  return join(root, 'derived')
}

/**
 * Per-session ID format the SessionBlob pack-path resolver accepts.
 * Mirrors the conservative subset that the importers actually emit
 * (`ses_<hex>` from canonical ID derivation, plus the broader
 * `prosa.session.v2:<provider>:<key>` external-key form). The pattern
 * deliberately forbids path separators, `..`, control characters, and
 * any byte that could trigger filesystem-specific corner cases on
 * Linux/macOS/Windows.
 *
 * Allowed characters: ASCII letters, digits, `_`, `-`, `:`, `.`,
 * length 1..200. The colon supports the qualified external-key form
 * (`prosa.session.v2:claude:abc`); on Windows colons in filenames
 * collide with drive letters, but the SessionBlob pack lives under a
 * deeply-nested derived directory and the colon does not appear in
 * the drive-letter position, so the practical risk is bounded. The
 * length cap is conservative — real session IDs are well under 100
 * characters — and protects against pathological inputs.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_\-:.]{1,200}$/

function assertValidSessionId(sessionId: unknown): asserts sessionId is string {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('sessionBlobPackPath: sessionId must be a non-empty string')
  }
  // Reject `..` even when the rest of the pattern matches, so a
  // pathological caller cannot route through the per-epoch directory
  // via `..` segments after they pass the character-class check
  // (the regex does not match `..` on its own, but `_..`, `:.`, etc.
  // would slip through without this explicit guard).
  if (sessionId === '.' || sessionId === '..' || sessionId.includes('..')) {
    throw new Error(`sessionBlobPackPath: sessionId must not contain '..' segments: ${JSON.stringify(sessionId)}`)
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      `sessionBlobPackPath: sessionId contains characters outside [A-Za-z0-9_\\-:.] or exceeds 200 chars: ${JSON.stringify(sessionId)}`,
    )
  }
}

function assertValidEpoch(epoch: unknown): asserts epoch is number {
  if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 0 || !Number.isSafeInteger(epoch)) {
    throw new Error(`sessionBlobPackPath: epoch must be a non-negative safe integer, got ${String(epoch)}`)
  }
}

/**
 * `<bundleRoot>/derived/session-blob/epoch-<n>` — per-epoch parent
 * directory for SessionBlobPackV2 packs. The runtime writer creates
 * this directory before emitting each session's pack; `loadSessionBlobPack`
 * reads from it. The naming mirrors bundle-v2's `epochs/<n>/` grouping
 * so epoch-wide operations (purge, list, rebuild) compose cleanly.
 *
 * Validates `epoch` is a non-negative safe integer; throws otherwise.
 */
export function sessionBlobEpochDir(bundleRoot: string, epoch: number): string {
  assertValidEpoch(epoch)
  return join(derivedPaths(bundleRoot).sessionBlob, `epoch-${epoch}`)
}

/**
 * Canonical on-disk path of a SessionBlobPackV2 pack file:
 * `<bundleRoot>/derived/session-blob/epoch-<n>/<session_id>.pack`.
 *
 * Validates inputs to prevent path-traversal injection:
 *
 *   - `sessionId` must be a non-empty string matching
 *     `/^[A-Za-z0-9_\\-:.]{1,200}$/` and must not contain `..`.
 *     Path separators (`/`, `\`), null bytes, control characters,
 *     spaces, and unicode noncharacters are all rejected. This is
 *     strictly more conservative than the canonical ID grammar the
 *     importers emit; legitimate IDs pass without modification.
 *   - `epoch` must be a non-negative safe integer.
 *
 * Pure function — no filesystem side effects. The runtime writer
 * still owns directory creation (`mkdir -p`) and pack emission; this
 * helper is the single source of truth for *where* each pack lives so
 * the future reader (`loadSessionBlobPack`) can resolve it without
 * re-deriving the layout.
 */
export function sessionBlobPackPath(bundleRoot: string, sessionId: string, epoch: number): string {
  assertValidSessionId(sessionId)
  // assertValidEpoch is called by sessionBlobEpochDir; calling it
  // here too would duplicate the message. Trust the composed call.
  return join(sessionBlobEpochDir(bundleRoot, epoch), `${sessionId}.pack`)
}
