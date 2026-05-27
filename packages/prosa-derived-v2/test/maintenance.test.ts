// Tests for `derivedLayerMaintenanceSummary`.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildCompactManifestV2, writeCompactManifestV2 } from '../src/compaction/manifest.js'
import type { CompactionPlan } from '../src/compaction/planner.js'
import { sessionBlobEpochDir, sessionBlobPackPath } from '../src/derived-layout.js'
import { derivedLayerMaintenanceSummary } from '../src/maintenance.js'
import { identityCompressor } from '../src/session-blob/reader.js'
import { writeSessionBlobPack } from '../src/session-blob/writer.js'

const GENERATED_AT = '2026-05-19T12:00:00.000Z'

async function plantSegment(bundleRoot: string, epoch: number, file: string, size: number): Promise<void> {
  const dir = join(bundleRoot, 'epochs', String(epoch), 'projection')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, file), Buffer.alloc(size))
}

async function plantSessionBlob(bundleRoot: string, sessionId: string, epoch: number): Promise<void> {
  const messages = [
    {
      message_id: 'msg_000000',
      ordinal: 0,
      role: 'user' as const,
      timestamp: '2026-05-19T00:00:00.000Z',
      turn_id: 'tur_0',
      blocks: [
        {
          block_id: 'blk_0_0',
          block_type: 'text',
          body: { kind: 'inline' as const, text: 'hi', byte_length: 2 },
        },
      ],
    },
  ]
  const result = writeSessionBlobPack({ session_id: sessionId, epoch, messages }, identityCompressor)
  await mkdir(sessionBlobEpochDir(bundleRoot, epoch), { recursive: true })
  await writeFile(sessionBlobPackPath(bundleRoot, sessionId, epoch), result.pack)
}

function planFor(seq: number, byteLength: number): CompactionPlan {
  return {
    empty: false,
    entities: [
      {
        entityType: 'sessions',
        reason: 'low_count_byte_ceiling',
        outputPath: `epochs${sep}compact-${String(seq).padStart(4, '0')}${sep}projection${sep}sessions.compacted.parquet`,
        totalBytesIn: byteLength,
        segmentsToMerge: [{ epoch: 1, path: `epochs${sep}1${sep}projection${sep}sessions.parquet`, byteLength }],
      },
    ],
  }
}

describe('derivedLayerMaintenanceSummary', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-maintenance-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns zero rollups for a fresh bundle', async () => {
    const summary = await derivedLayerMaintenanceSummary(bundleRoot)

    expect(summary.status.session_count).toBe(0)
    expect(summary.status.tantivy.ready_for_read).toBe(false)
    expect(summary.projection.total_segments).toBe(0)
    expect(summary.projection.total_bytes).toBe(0)
    expect(summary.compaction.empty).toBe(true)
    expect(summary.compaction.entity_count).toBe(0)
    expect(summary.compaction.reasons).toEqual([])
    expect(summary.persisted_compactions).toEqual({ count: 0, consistent_count: 0, inconsistent_count: 0 })
    expect(summary.gc.candidate_count).toBe(0)
    expect(summary.gc.safe_to_delete).toEqual({ count: 0, bytes: 0 })
    expect(summary.gc.blocked).toEqual({ count: 0, bytes: 0 })
  })

  it('reflects SessionBlob + projection state when no compaction has run', async () => {
    await plantSessionBlob(bundleRoot, 'ses_alpha', 1)
    await plantSegment(bundleRoot, 1, 'sessions.parquet', 100)
    await plantSegment(bundleRoot, 1, 'messages.parquet', 200)

    const summary = await derivedLayerMaintenanceSummary(bundleRoot)

    expect(summary.status.session_count).toBe(1)
    expect(summary.projection.total_segments).toBe(2)
    expect(summary.projection.total_bytes).toBe(300)
    expect(summary.compaction.empty).toBe(true)
    expect(summary.persisted_compactions.count).toBe(0)
    expect(summary.gc.candidate_count).toBe(0)
  })

  it('flags compaction-plan fires when enough small projection segments exist', async () => {
    for (let epoch = 1; epoch <= 17; epoch++) {
      await plantSegment(bundleRoot, epoch, 'sessions.parquet', 1024)
    }
    const summary = await derivedLayerMaintenanceSummary(bundleRoot)

    expect(summary.compaction.empty).toBe(false)
    expect(summary.compaction.entity_count).toBe(1)
    expect(summary.compaction.reasons).toEqual(['low_count_byte_ceiling'])
  })

  it('rolls up persisted compactions + GC blocked-vs-safe partition', async () => {
    // Plant a fired plan worth of segments.
    for (let epoch = 1; epoch <= 17; epoch++) {
      await plantSegment(bundleRoot, epoch, 'sessions.parquet', 1024)
    }
    // Persist manifest at seq 1 — outputs missing → inconsistent + GC blocked.
    await writeCompactManifestV2(
      bundleRoot,
      buildCompactManifestV2({ plan: planFor(1, 5_120), generatedAt: GENERATED_AT }),
    )
    const blockedSummary = await derivedLayerMaintenanceSummary(bundleRoot)
    expect(blockedSummary.persisted_compactions.count).toBe(1)
    expect(blockedSummary.persisted_compactions.consistent_count).toBe(0)
    expect(blockedSummary.persisted_compactions.inconsistent_count).toBe(1)
    expect(blockedSummary.gc.candidate_count).toBe(1)
    expect(blockedSummary.gc.blocked.count).toBe(1)
    expect(blockedSummary.gc.safe_to_delete.count).toBe(0)

    // Simulate runtime worker landing the compacted output.
    const compactedDir = join(bundleRoot, 'epochs', 'compact-0001', 'projection')
    await mkdir(compactedDir, { recursive: true })
    await writeFile(join(compactedDir, 'sessions.compacted.parquet'), Buffer.alloc(2048))

    const safeSummary = await derivedLayerMaintenanceSummary(bundleRoot)
    expect(safeSummary.persisted_compactions.consistent_count).toBe(1)
    expect(safeSummary.persisted_compactions.inconsistent_count).toBe(0)
    expect(safeSummary.gc.blocked.count).toBe(0)
    expect(safeSummary.gc.safe_to_delete.count).toBe(1)
  })

  it('deduplicates compaction fire reasons across multiple entities firing for the same reason', async () => {
    // Plant 17 small files for two distinct entities — both fire
    // for the same reason. The summary's `reasons` list dedupes.
    for (let epoch = 1; epoch <= 17; epoch++) {
      await plantSegment(bundleRoot, epoch, 'sessions.parquet', 1024)
      await plantSegment(bundleRoot, epoch, 'messages.parquet', 1024)
    }
    const summary = await derivedLayerMaintenanceSummary(bundleRoot)
    expect(summary.compaction.entity_count).toBe(2)
    expect(summary.compaction.reasons).toEqual(['low_count_byte_ceiling'])
  })
})
