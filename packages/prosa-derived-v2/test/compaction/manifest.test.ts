// Tests for `buildCompactManifestV2` — the Lane 3 compact-manifest
// builder. Asserts on the per-entity superseded list, the
// compaction_seq derivation, and the failure modes for empty plans
// and malformed output paths.

import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildCompactManifestV2 } from '../../src/compaction/manifest.js'
import type { CompactionPlan } from '../../src/compaction/planner.js'

const GENERATED_AT = '2026-05-19T12:00:00.000Z'

function planWithEntity(overrides: Partial<CompactionPlan['entities'][number]> = {}): CompactionPlan {
  return {
    empty: false,
    entities: [
      {
        entityType: 'sessions',
        reason: 'low_count_byte_ceiling',
        outputPath: `epochs${sep}compact-0001${sep}projection${sep}sessions.compacted.parquet`,
        totalBytesIn: 5_120,
        segmentsToMerge: [
          { epoch: 1, path: `epochs${sep}1${sep}projection${sep}sessions.parquet`, byteLength: 2_048 },
          { epoch: 2, path: `epochs${sep}2${sep}projection${sep}sessions.parquet`, byteLength: 3_072 },
        ],
        ...overrides,
      },
    ],
  }
}

describe('buildCompactManifestV2', () => {
  it('builds a single-entity manifest with the superseded list, byte total, and derived seq', () => {
    const plan = planWithEntity()
    const manifest = buildCompactManifestV2({ plan, generatedAt: GENERATED_AT })

    expect(manifest.schema).toBe('prosa.compact-manifest.v2')
    expect(manifest.compaction_seq).toBe(1)
    expect(manifest.generated_at).toBe(GENERATED_AT)
    expect(manifest.entities).toHaveLength(1)
    const [entity] = manifest.entities
    expect(entity?.entity_type).toBe('sessions')
    expect(entity?.reason).toBe('low_count_byte_ceiling')
    expect(entity?.total_bytes_in).toBe(5_120)
    expect(entity?.superseded.map((s) => s.epoch)).toEqual([1, 2])
    expect(entity?.superseded.map((s) => s.byte_length)).toEqual([2_048, 3_072])
  })

  it('builds a multi-entity manifest with one row per entity, all sharing the same seq', () => {
    const plan: CompactionPlan = {
      empty: false,
      entities: [
        {
          entityType: 'sessions',
          reason: 'low_count_byte_ceiling',
          outputPath: `epochs${sep}compact-0007${sep}projection${sep}sessions.compacted.parquet`,
          totalBytesIn: 1_024,
          segmentsToMerge: [
            { epoch: 1, path: `epochs${sep}1${sep}projection${sep}sessions.parquet`, byteLength: 1_024 },
          ],
        },
        {
          entityType: 'messages',
          reason: 'file_count_trigger',
          outputPath: `epochs${sep}compact-0007${sep}projection${sep}messages.compacted.parquet`,
          totalBytesIn: 2_048,
          segmentsToMerge: [
            { epoch: 2, path: `epochs${sep}2${sep}projection${sep}messages.parquet`, byteLength: 2_048 },
          ],
        },
      ],
    }
    const manifest = buildCompactManifestV2({ plan, generatedAt: GENERATED_AT })

    expect(manifest.compaction_seq).toBe(7)
    expect(manifest.entities.map((e) => e.entity_type)).toEqual(['sessions', 'messages'])
    expect(manifest.entities[0]?.reason).toBe('low_count_byte_ceiling')
    expect(manifest.entities[1]?.reason).toBe('file_count_trigger')
  })

  it('refuses to build a manifest for an empty plan (CompactionPlan.empty=true)', () => {
    expect(() => buildCompactManifestV2({ plan: { empty: true, entities: [] }, generatedAt: GENERATED_AT })).toThrow(
      /empty plan/,
    )
  })

  it('refuses to build when entities disagree on the compaction seq', () => {
    const plan: CompactionPlan = {
      empty: false,
      entities: [
        {
          entityType: 'sessions',
          reason: 'low_count_byte_ceiling',
          outputPath: `epochs${sep}compact-0001${sep}projection${sep}sessions.compacted.parquet`,
          totalBytesIn: 0,
          segmentsToMerge: [],
        },
        {
          entityType: 'messages',
          reason: 'low_count_byte_ceiling',
          outputPath: `epochs${sep}compact-0002${sep}projection${sep}messages.compacted.parquet`,
          totalBytesIn: 0,
          segmentsToMerge: [],
        },
      ],
    }
    expect(() => buildCompactManifestV2({ plan, generatedAt: GENERATED_AT })).toThrow(/disagree on compaction sequence/)
  })

  it('throws when an entity output path is missing the compact-<NNNN> segment', () => {
    const plan = planWithEntity({
      outputPath: `epochs${sep}999${sep}projection${sep}sessions.compacted.parquet`,
    })
    expect(() => buildCompactManifestV2({ plan, generatedAt: GENERATED_AT })).toThrow(/compact-<NNNN> segment/)
  })

  it('accepts the platform output path verbatim (round-trips the planner-emitted strings)', () => {
    // The planner builds outputPath via `path.sep`; the manifest builder
    // must accept whatever the planner emits without rewriting it.
    const plan = planWithEntity()
    const manifest = buildCompactManifestV2({ plan, generatedAt: GENERATED_AT })
    expect(manifest.entities[0]?.output_path).toBe(plan.entities[0]?.outputPath)
    expect(manifest.entities[0]?.superseded[0]?.path).toBe(plan.entities[0]?.segmentsToMerge[0]?.path)
  })
})
