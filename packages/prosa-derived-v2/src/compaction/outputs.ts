// Persisted-compaction output audit.
//
// Walks every persisted `compact.manifest.json` under
// `<bundleRoot>/epochs/compact-<NNNN>/` and for each entity row
// checks whether the runtime worker actually wrote the
// `output_path` Parquet file to disk. The result is the cross-
// check primitive that pairs with `listSupersededSegmentsFromManifests`:
//
//   - `superseded-segments` answers "what was merged AWAY?"
//   - `compacted-outputs` answers "what was the merge SUPPOSED to
//     produce, and did it actually land?"
//
// Together they tell an auditor whether a compaction-seq is in a
// consistent post-merge state (manifest + outputs both present)
// or in an inconsistent state (manifest exists but outputs
// missing — runtime worker crashed mid-way; or outputs exist but
// manifest missing — partial cleanup; etc.).
//
// Pure-read. Containment inherits from `readCompactManifestV2`.

import type { Dirent } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { readCompactManifestV2 } from './manifest.js'

const COMPACT_DIR_PATTERN = /^compact-(\d+)$/

export interface CompactedEntityOutputAudit {
  /** Canonical entity name from the manifest. */
  entity_type: string
  /** Bundle-root-relative path the manifest claims for this
   *  entity's compacted output. */
  output_path: string
  /** True iff a regular file lives at `<bundleRoot>/<output_path>`
   *  on disk. Symlinked files report `false` (the canonical
   *  compaction output is a real file). */
  exists: boolean
  /** Stored size in bytes; `null` when `exists === false`. */
  byte_length: number | null
}

export interface CompactedManifestAudit {
  /** Compaction sequence the manifest declares. */
  compaction_seq: number
  /** Bundle-root-relative path of the persisted manifest. */
  manifest_path: string
  /** Per-entity audit of the manifest's declared output paths. */
  entity_outputs: CompactedEntityOutputAudit[]
  /** Convenience: `true` iff every entity output exists as a
   *  regular file. False when at least one is missing or a
   *  symlink. */
  consistent: boolean
}

/**
 * Walk every persisted manifest under `<bundleRoot>/epochs/compact-<NNNN>/`
 * and cross-check each entity's claimed `output_path` against on-disk
 * state. Result is sorted by `compaction_seq` ascending.
 *
 * Use cases:
 *
 *   - Post-compaction audit: confirm the runtime worker produced
 *     every output it promised in the manifest before GC removes
 *     the superseded sources.
 *   - Resume planning: an inconsistent compaction-seq (manifest
 *     present, some output missing) is the canonical "crashed
 *     mid-compaction" signal — the runtime worker can re-execute
 *     just that seq.
 *
 * Empty bundles (no `epochs/`, no `compact-<NNNN>/` subdirs)
 * return `[]`. Symlinked `compact-<NNNN>/` propagates the reader's
 * `refuseSymlinkedIntermediate` throw without being captured.
 */
export async function listCompactedOutputs(bundleRoot: string): Promise<CompactedManifestAudit[]> {
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
    const match = COMPACT_DIR_PATTERN.exec(entry.name)
    if (!match) continue
    const n = Number(match[1])
    if (!Number.isSafeInteger(n) || n < 0) continue
    compactionSeqs.push(n)
  }
  compactionSeqs.sort((a, b) => a - b)

  const result: CompactedManifestAudit[] = []
  for (const seq of compactionSeqs) {
    let manifest: Awaited<ReturnType<typeof readCompactManifestV2>>
    try {
      manifest = await readCompactManifestV2(bundleRoot, seq)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue
      throw err
    }
    const manifestPath = join('epochs', `compact-${String(seq).padStart(4, '0')}`, 'compact.manifest.json')
    const entityOutputs: CompactedEntityOutputAudit[] = []
    let allConsistent = true
    for (const entity of manifest.entities) {
      const absolute = join(bundleRoot, entity.output_path)
      let exists = false
      let byteLength: number | null = null
      try {
        const st = await lstat(absolute)
        // The canonical compaction output is a real file. A symlink
        // there is suspicious (runtime worker only writes regular
        // files); report as not-existing so audit catches it.
        if (st.isFile() && !st.isSymbolicLink()) {
          exists = true
          byteLength = st.size
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
      }
      if (!exists) allConsistent = false
      entityOutputs.push({
        entity_type: entity.entity_type,
        output_path: entity.output_path,
        exists,
        byte_length: byteLength,
      })
    }
    result.push({
      compaction_seq: manifest.compaction_seq,
      manifest_path: manifestPath,
      entity_outputs: entityOutputs,
      consistent: allConsistent,
    })
  }
  return result
}
