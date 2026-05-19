// Tests for `listCompactedOutputs`.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildCompactManifestV2, writeCompactManifestV2 } from '../../src/compaction/manifest.js'
import { listCompactedOutputs } from '../../src/compaction/outputs.js'
import type { CompactionPlan } from '../../src/compaction/planner.js'

const GENERATED_AT = '2026-05-19T12:00:00.000Z'

function planFor(seq: number, entityType: string, byteLength: number): CompactionPlan {
  return {
    empty: false,
    entities: [
      {
        entityType,
        reason: 'low_count_byte_ceiling',
        outputPath: `epochs${sep}compact-${String(seq).padStart(4, '0')}${sep}projection${sep}${entityType}.compacted.parquet`,
        totalBytesIn: byteLength,
        segmentsToMerge: [
          {
            epoch: 1,
            path: `epochs${sep}1${sep}projection${sep}${entityType}.parquet`,
            byteLength,
          },
        ],
      },
    ],
  }
}

async function plantCompactedFile(bundleRoot: string, seq: number, entityType: string, bytes: number): Promise<void> {
  const dir = join(bundleRoot, 'epochs', `compact-${String(seq).padStart(4, '0')}`, 'projection')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${entityType}.compacted.parquet`), Buffer.alloc(bytes))
}

describe('listCompactedOutputs', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-compacted-outputs-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns [] for a bundle without an epochs/ directory', async () => {
    expect(await listCompactedOutputs(bundleRoot)).toEqual([])
  })

  it('reports `consistent: false` when the manifest exists but the compacted output is missing', async () => {
    const plan = planFor(1, 'sessions', 4_096)
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan, generatedAt: GENERATED_AT }))

    const result = await listCompactedOutputs(bundleRoot)
    expect(result).toHaveLength(1)
    expect(result[0]?.compaction_seq).toBe(1)
    expect(result[0]?.consistent).toBe(false)
    expect(result[0]?.entity_outputs).toHaveLength(1)
    expect(result[0]?.entity_outputs[0]?.entity_type).toBe('sessions')
    expect(result[0]?.entity_outputs[0]?.exists).toBe(false)
    expect(result[0]?.entity_outputs[0]?.byte_length).toBeNull()
  })

  it('reports `consistent: true` and the byte length when the compacted output exists', async () => {
    const plan = planFor(1, 'sessions', 4_096)
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan, generatedAt: GENERATED_AT }))
    await plantCompactedFile(bundleRoot, 1, 'sessions', 12_345)

    const result = await listCompactedOutputs(bundleRoot)
    expect(result[0]?.consistent).toBe(true)
    expect(result[0]?.entity_outputs[0]?.exists).toBe(true)
    expect(result[0]?.entity_outputs[0]?.byte_length).toBe(12_345)
  })

  it('reports an output path that is a symlink as not-existing (canonical outputs are real files)', async () => {
    const plan = planFor(1, 'sessions', 4_096)
    await writeCompactManifestV2(bundleRoot, buildCompactManifestV2({ plan, generatedAt: GENERATED_AT }))
    // Plant a symlink at the output path instead of a real file.
    const dir = join(bundleRoot, 'epochs', 'compact-0001', 'projection')
    await mkdir(dir, { recursive: true })
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-compacted-outputs-ext-'))
    try {
      const target = join(external, 'fake.parquet')
      await writeFile(target, Buffer.alloc(64))
      await symlink(target, join(dir, 'sessions.compacted.parquet'))

      const result = await listCompactedOutputs(bundleRoot)
      expect(result[0]?.entity_outputs[0]?.exists).toBe(false)
      expect(result[0]?.consistent).toBe(false)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('aggregates multiple compaction sequences in ascending order', async () => {
    // Persist three manifests: seq 1 with output present, seq 2 without, seq 3 with present.
    await writeCompactManifestV2(
      bundleRoot,
      buildCompactManifestV2({ plan: planFor(1, 'sessions', 100), generatedAt: GENERATED_AT }),
    )
    await plantCompactedFile(bundleRoot, 1, 'sessions', 100)
    await writeCompactManifestV2(
      bundleRoot,
      buildCompactManifestV2({ plan: planFor(2, 'messages', 200), generatedAt: GENERATED_AT }),
    )
    // seq 2 intentionally lacks the compacted output
    await writeCompactManifestV2(
      bundleRoot,
      buildCompactManifestV2({ plan: planFor(3, 'tool_calls', 300), generatedAt: GENERATED_AT }),
    )
    await plantCompactedFile(bundleRoot, 3, 'tool_calls', 300)

    const result = await listCompactedOutputs(bundleRoot)
    expect(result.map((r) => r.compaction_seq)).toEqual([1, 2, 3])
    expect(result.map((r) => r.consistent)).toEqual([true, false, true])
    expect(result[0]?.entity_outputs[0]?.byte_length).toBe(100)
    expect(result[1]?.entity_outputs[0]?.byte_length).toBeNull()
    expect(result[2]?.entity_outputs[0]?.byte_length).toBe(300)
  })

  it('silently skips compact-<NNNN>/ directories that lack a manifest', async () => {
    await writeCompactManifestV2(
      bundleRoot,
      buildCompactManifestV2({ plan: planFor(1, 'sessions', 100), generatedAt: GENERATED_AT }),
    )
    await mkdir(join(bundleRoot, 'epochs', 'compact-0002'), { recursive: true })

    const result = await listCompactedOutputs(bundleRoot)
    expect(result.map((r) => r.compaction_seq)).toEqual([1])
  })

  it('symlinked `<bundleRoot>/epochs/compact-<NNNN>/` propagates the reader symlink throw', async () => {
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-compacted-outputs-sym-'))
    try {
      await mkdir(join(bundleRoot, 'epochs'), { recursive: true })
      await symlink(external, join(bundleRoot, 'epochs', 'compact-0001'))
      await expect(listCompactedOutputs(bundleRoot)).rejects.toThrow(/symlink/i)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })
})
