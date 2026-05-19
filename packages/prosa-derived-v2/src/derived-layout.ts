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
   *  directory; the per-session pack layout under this path is owned
   *  by the runtime writer when it lands. */
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
