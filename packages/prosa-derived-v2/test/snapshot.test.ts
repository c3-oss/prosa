// Tests for `derivedLayerSnapshot`.
//
// These tests focus on the composition contract — the snapshot
// re-uses the existing primitives' outputs, so we only need to
// confirm:
//
//   1. Every sub-component is present with the expected zero-state
//      shape on a fresh bundle.
//   2. The snapshot reuses the SAME maintenance summary the
//      recommendations layer ran against (internal coherence).
//   3. Capabilities are emitted regardless of bundle state.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { derivedLayerCapabilities } from '../src/capabilities.js'
import { buildCompactManifestV2, writeCompactManifestV2 } from '../src/compaction/manifest.js'
import type { CompactionPlan } from '../src/compaction/planner.js'
import { derivedLayerSnapshot } from '../src/snapshot.js'

const GENERATED_AT = '2026-05-19T12:00:00.000Z'

describe('derivedLayerSnapshot', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-snapshot-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns the zero-state shape for a fresh bundle with every sub-component present', async () => {
    const snapshot = await derivedLayerSnapshot(bundleRoot)
    expect(snapshot.maintenance.status.session_count).toBe(0)
    expect(snapshot.maintenance.compaction.empty).toBe(true)
    expect(snapshot.recommendations).toEqual([])
    expect(snapshot.footprint.total_bytes).toBe(0)
    expect(snapshot.capabilities.schema_ids.compact_manifest).toBe('prosa.compact-manifest.v2')
  })

  it('emits capabilities regardless of bundle state (matches `derivedLayerCapabilities()` exactly)', async () => {
    const snapshot = await derivedLayerSnapshot(bundleRoot)
    expect(snapshot.capabilities).toEqual(derivedLayerCapabilities())
  })

  it('recommendations are derived from the same maintenance summary the snapshot surfaces', async () => {
    // Plant 17 small projection segments to fire the compaction
    // planner, then verify the snapshot reports both the fired
    // plan (in maintenance.compaction) and the run_compaction
    // recommendation.
    for (let epoch = 1; epoch <= 17; epoch++) {
      const dir = join(bundleRoot, 'epochs', String(epoch), 'projection')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'sessions.parquet'), Buffer.alloc(1024))
    }
    const snapshot = await derivedLayerSnapshot(bundleRoot)
    expect(snapshot.maintenance.compaction.empty).toBe(false)
    expect(snapshot.maintenance.compaction.reasons).toEqual(['low_count_byte_ceiling'])
    expect(snapshot.recommendations.map((r) => r.kind)).toEqual(['run_compaction'])
  })

  it('CQ-111 parallel: when a persisted manifest is inconsistent, the snapshot emits resume_compaction first and suppresses gc_superseded', async () => {
    for (let epoch = 1; epoch <= 17; epoch++) {
      const dir = join(bundleRoot, 'epochs', String(epoch), 'projection')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'sessions.parquet'), Buffer.alloc(1024))
    }
    const plan: CompactionPlan = {
      empty: false,
      entities: [
        {
          entityType: 'sessions',
          reason: 'low_count_byte_ceiling',
          outputPath: 'epochs/compact-0001/projection/sessions.compacted.parquet',
          totalBytesIn: 17 * 1024,
          segmentsToMerge: Array.from({ length: 17 }, (_, i) => ({
            epoch: i + 1,
            path: `epochs/${i + 1}/projection/sessions.parquet`,
            byteLength: 1024,
          })),
        },
      ],
    }
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan, generatedAt: GENERATED_AT }))
    // Do NOT plant the compacted output → manifest inconsistent.

    const snapshot = await derivedLayerSnapshot(bundleRoot)
    const kinds = snapshot.recommendations.map((r) => r.kind)
    expect(kinds[0]).toBe('resume_compaction')
    expect(kinds).not.toContain('gc_superseded')
    expect(snapshot.maintenance.persisted_compactions.inconsistent_count).toBe(1)
  })

  it('footprint and maintenance read the same bundle in parallel — planted tantivy files surface in footprint and the derived tree is detectable in maintenance', async () => {
    // Use tantivy index files for the cross-check rather than
    // session-blob packs: planting a raw buffer with the
    // `.pack` extension would force `bundleDerivedStatus` to try
    // to decode it as a SessionBlobPackV2 and fail. Tantivy index
    // dir contents are walked by footprint without any structural
    // parsing, so a raw buffer is fine.
    await mkdir(join(bundleRoot, 'derived', 'tantivy', 'index'), { recursive: true })
    await writeFile(join(bundleRoot, 'derived', 'tantivy', 'index', 'segment-0.idx'), Buffer.alloc(2048))
    await writeFile(join(bundleRoot, 'derived', 'tantivy', 'index', 'segment-1.idx'), Buffer.alloc(512))

    const snapshot = await derivedLayerSnapshot(bundleRoot)
    // footprint surfaces the raw bytes across both files.
    expect(snapshot.footprint.tantivy.byte_count).toBe(2048 + 512)
    expect(snapshot.footprint.tantivy.file_count).toBe(2)
    expect(snapshot.footprint.total_bytes).toBe(2048 + 512)
    // maintenance.status.tantivy is unrelated to the on-disk
    // index byte count — it tracks rebuild status — but the
    // snapshot still emits it alongside the footprint.
    expect(snapshot.maintenance.status.tantivy).toBeDefined()
  })

  it('CQ-113: snapshot fails closed when the Tantivy checkpoint JSON is malformed (inherits maintenance fail-closed semantics)', async () => {
    // The snapshot composes `derivedLayerMaintenanceSummary`,
    // which reads Tantivy status through the checkpoint reader.
    // The reader fails closed on malformed checkpoint JSON, so
    // the snapshot must propagate that failure rather than
    // returning a partial result. This is the negative
    // counterpart to the positive composition test above.
    await mkdir(join(bundleRoot, 'derived', 'tantivy'), { recursive: true })
    await writeFile(join(bundleRoot, 'derived', 'tantivy', 'checkpoint.json'), 'xxxxxxx not json xxxxxxx')

    await expect(derivedLayerSnapshot(bundleRoot)).rejects.toThrow(/readIndexCheckpoint.*malformed JSON/)
  })
})
