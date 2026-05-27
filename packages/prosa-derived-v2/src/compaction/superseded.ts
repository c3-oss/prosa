// Bundle-wide aggregator over persisted compact manifests.
//
// Walks every `<bundleRoot>/epochs/compact-<NNNN>/compact.manifest.json`
// on disk, loads each via the deep-validated reader
// `readCompactManifestV2`, and rolls up the `superseded[]` arrays
// across all compaction sequences. Pairs with audit/GC workflows
// that need to know "which epoch segments have been superseded and
// are now safe to remove?" without re-deriving from the live
// projection state.
//
// Pure-read (no filesystem mutation). Containment guards are
// inherited from `readCompactManifestV2` — a symlinked
// `<bundleRoot>/epochs` or `compact-<NNNN>/` propagates the reader's
// throw; per-pack containment from the reader's `lstat` on the
// final manifest path also propagates.

import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { readCompactManifestV2 } from './manifest.js'

const COMPACT_DIR_PATTERN = /^compact-(\d+)$/

export interface SupersededSegment {
  /** Bundle-root-relative path of the superseded source segment
   *  (e.g. `epochs/1/projection/sessions.parquet`). Matches the
   *  `path` field on the persisted manifest's `superseded[]` entry. */
  path: string
  /** Epoch the superseded segment lived in. */
  epoch: number
  /** Stored byte length of the segment (from the manifest). */
  byte_length: number
  /** Canonical entity name (`sessions`, `messages`, ...) the
   *  segment was a row source for. Re-surfaces the parent
   *  entity's `entity_type` field. */
  entity_type: string
  /** Sequence number of the compaction run that superseded this
   *  segment. Cross-reference into
   *  `epochs/compact-<NNNN>/compact.manifest.json`. */
  compaction_seq: number
}

/**
 * Walk persisted compact manifests + aggregate every superseded
 * segment they record. Result is sorted by `(compaction_seq,
 * entity_type, epoch, path)` ascending so audit reports are
 * deterministic. Empty bundles (no `epochs/`, no `compact-<NNNN>/`
 * subdirectories, or no `compact.manifest.json` files) return `[]`.
 *
 * A `compact-<NNNN>/` directory without a manifest is silently
 * skipped — the runtime worker is supposed to write the manifest
 * as part of the same atomic commit, but a partial state should
 * not crash the audit. The reader's deep validation propagates if
 * a manifest is present-but-malformed; callers can decide whether
 * to halt the audit or capture and continue.
 */
export async function listSupersededSegmentsFromManifests(bundleRoot: string): Promise<SupersededSegment[]> {
  const epochsDir = join(bundleRoot, 'epochs')
  let entries: Dirent[]
  try {
    entries = await readdir(epochsDir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw err
  }

  const compactionSeqs: number[] = []
  for (const entry of entries) {
    // Match `compact-<NNNN>` by name regardless of symlink-ness — the
    // reader's `refuseSymlinkedIntermediate` will throw on symlinked
    // entries (CQ-094/CQ-098 parity). Silently skipping a symlinked
    // compact dir here would mask a hostile setup that planted a link
    // to capture audit/GC inputs.
    const match = COMPACT_DIR_PATTERN.exec(entry.name)
    if (!match) continue
    const n = Number(match[1])
    if (!Number.isSafeInteger(n) || n < 0) continue
    compactionSeqs.push(n)
  }
  compactionSeqs.sort((a, b) => a - b)

  const result: SupersededSegment[] = []
  for (const seq of compactionSeqs) {
    let manifest: Awaited<ReturnType<typeof readCompactManifestV2>>
    try {
      manifest = await readCompactManifestV2(bundleRoot, seq)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') continue
      throw err
    }
    for (const entity of manifest.entities) {
      for (const segment of entity.superseded) {
        result.push({
          path: segment.path,
          epoch: segment.epoch,
          byte_length: segment.byte_length,
          entity_type: entity.entity_type,
          compaction_seq: manifest.compaction_seq,
        })
      }
    }
  }
  return result.sort(compareSupersededSegments)
}

function compareSupersededSegments(a: SupersededSegment, b: SupersededSegment): number {
  if (a.compaction_seq !== b.compaction_seq) return a.compaction_seq - b.compaction_seq
  if (a.entity_type !== b.entity_type) return a.entity_type < b.entity_type ? -1 : 1
  if (a.epoch !== b.epoch) return a.epoch - b.epoch
  if (a.path === b.path) return 0
  return a.path < b.path ? -1 : 1
}

export interface SupersededSegmentsRollup {
  /** Total superseded segments aggregated across every persisted
   *  manifest in the bundle. */
  total_segments: number
  /** Total bytes summed across every superseded segment. */
  total_bytes: number
  /** Per-entity rollup keyed by `entity_type`. */
  by_entity: Record<string, { count: number; bytes: number }>
  /** Per-compaction-seq rollup keyed by stringified seq (matches
   *  `summariseProjectionSegments`'s key style). */
  by_compaction_seq: Record<string, { count: number; bytes: number }>
}

/**
 * Roll up `listSupersededSegmentsFromManifests` into total /
 * per-entity / per-compaction-seq stats. Suitable for one-line
 * audit dashboards ("12 segments / 318 MiB superseded across 3
 * compaction runs and 5 entity types"). Empty bundle yields
 * `{ total_segments: 0, total_bytes: 0, by_entity: {},
 * by_compaction_seq: {} }`.
 */
export async function summariseSupersededSegments(bundleRoot: string): Promise<SupersededSegmentsRollup> {
  const segments = await listSupersededSegmentsFromManifests(bundleRoot)
  const rollup: SupersededSegmentsRollup = {
    total_segments: 0,
    total_bytes: 0,
    by_entity: {},
    by_compaction_seq: {},
  }
  for (const segment of segments) {
    rollup.total_segments += 1
    rollup.total_bytes += segment.byte_length

    if (rollup.by_entity[segment.entity_type] === undefined) {
      rollup.by_entity[segment.entity_type] = { count: 0, bytes: 0 }
    }
    const entity = rollup.by_entity[segment.entity_type]!
    entity.count += 1
    entity.bytes += segment.byte_length

    const seqKey = String(segment.compaction_seq)
    if (rollup.by_compaction_seq[seqKey] === undefined) {
      rollup.by_compaction_seq[seqKey] = { count: 0, bytes: 0 }
    }
    const seqRollup = rollup.by_compaction_seq[seqKey]!
    seqRollup.count += 1
    seqRollup.bytes += segment.byte_length
  }
  return rollup
}
