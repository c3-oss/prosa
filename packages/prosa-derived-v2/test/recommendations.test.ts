// Tests for `recommendMaintenanceActions`.

import { describe, expect, it } from 'vitest'

import type { DerivedLayerMaintenanceSummary } from '../src/maintenance.js'
import { recommendMaintenanceActions } from '../src/recommendations.js'

function summary(overrides: Partial<DerivedLayerMaintenanceSummary> = {}): DerivedLayerMaintenanceSummary {
  return {
    status: {
      tantivy: {
        checkpoint_present: false,
        index_dir_valid: false,
        ready_for_read: false,
        current_schema_fingerprint: 'blake3:0'.padEnd(71, '0'),
        last_indexed_rowid: null,
        schema_fingerprint: null,
        status: null,
        indexed_doc_count: null,
        source_doc_count: null,
        error_message: null,
      } as unknown as DerivedLayerMaintenanceSummary['status']['tantivy'],
      session_summaries: [],
      session_count: 0,
      session_blob_epochs: [],
    },
    projection: { total_segments: 0, total_bytes: 0, by_entity: {}, by_epoch: {} },
    compaction: { empty: true, entity_count: 0, reasons: [] },
    persisted_compactions: { count: 0, consistent_count: 0, inconsistent_count: 0 },
    gc: { candidate_count: 0, safe_to_delete: { count: 0, bytes: 0 }, blocked: { count: 0, bytes: 0 } },
    overlaps: { count: 0, paths: [] },
    ...overrides,
  }
}

describe('recommendMaintenanceActions', () => {
  it('returns [] for an idle bundle (every subsystem clean)', () => {
    expect(recommendMaintenanceActions(summary())).toEqual([])
  })

  it('emits `run_compaction` when the planner would fire', () => {
    const actions = recommendMaintenanceActions(
      summary({ compaction: { empty: false, entity_count: 2, reasons: ['low_count_byte_ceiling'] } }),
    )
    expect(actions).toEqual([{ kind: 'run_compaction', entity_count: 2, reasons: ['low_count_byte_ceiling'] }])
  })

  it('emits `gc_superseded` when consistent safe candidates exist', () => {
    const actions = recommendMaintenanceActions(
      summary({
        persisted_compactions: { count: 1, consistent_count: 1, inconsistent_count: 0 },
        gc: { candidate_count: 17, safe_to_delete: { count: 17, bytes: 17 * 1024 }, blocked: { count: 0, bytes: 0 } },
      }),
    )
    expect(actions).toEqual([{ kind: 'gc_superseded', safe_count: 17, safe_bytes: 17 * 1024 }])
  })

  it('emits `resume_compaction` first when a persisted compaction is inconsistent', () => {
    const actions = recommendMaintenanceActions(
      summary({
        persisted_compactions: { count: 1, consistent_count: 0, inconsistent_count: 1 },
        gc: { candidate_count: 17, safe_to_delete: { count: 0, bytes: 0 }, blocked: { count: 17, bytes: 17 * 1024 } },
        compaction: { empty: false, entity_count: 1, reasons: ['low_count_byte_ceiling'] },
      }),
    )
    // Order: resume first, then run_compaction. (No safe-to-delete
    // when everything is blocked.)
    expect(actions.map((a) => a.kind)).toEqual(['resume_compaction', 'run_compaction'])
    expect((actions[0] as { inconsistent_count: number }).inconsistent_count).toBe(1)
  })

  it('CQ-111: suppresses `gc_superseded` whenever any persisted compaction is inconsistent — even when gc-plan independently classified rows as safe', () => {
    // Mixed-state scenario: one consistent compaction (its outputs
    // exist, so gc-plan would tag its superseded sources as
    // safe_to_delete), one inconsistent one (its outputs are
    // missing). The recommender must NOT emit gc_superseded — the
    // resuming merge may still need superseded sources from the
    // inconsistent seq. Once resume_compaction is acted upon and
    // re-runs the audit, this slot opens back up.
    const actions = recommendMaintenanceActions(
      summary({
        persisted_compactions: { count: 2, consistent_count: 1, inconsistent_count: 1 },
        gc: { candidate_count: 20, safe_to_delete: { count: 10, bytes: 10240 }, blocked: { count: 10, bytes: 10240 } },
        compaction: { empty: false, entity_count: 1, reasons: ['file_count_trigger'] },
      }),
    )
    expect(actions.map((a) => a.kind)).toEqual(['resume_compaction', 'run_compaction'])
  })

  it('CQ-111: emits `gc_superseded` only when every persisted compaction is consistent', () => {
    const actions = recommendMaintenanceActions(
      summary({
        persisted_compactions: { count: 2, consistent_count: 2, inconsistent_count: 0 },
        gc: { candidate_count: 10, safe_to_delete: { count: 10, bytes: 10240 }, blocked: { count: 0, bytes: 0 } },
        compaction: { empty: false, entity_count: 1, reasons: ['file_count_trigger'] },
      }),
    )
    expect(actions.map((a) => a.kind)).toEqual(['gc_superseded', 'run_compaction'])
    expect((actions[0] as { safe_count: number }).safe_count).toBe(10)
  })

  it('omits `gc_superseded` when safe_to_delete.count is zero even if blocked rows exist', () => {
    const actions = recommendMaintenanceActions(
      summary({
        persisted_compactions: { count: 1, consistent_count: 0, inconsistent_count: 1 },
        gc: { candidate_count: 5, safe_to_delete: { count: 0, bytes: 0 }, blocked: { count: 5, bytes: 5000 } },
      }),
    )
    expect(actions.map((a) => a.kind)).toEqual(['resume_compaction'])
  })

  it('emits `gc_superseded` even when there is also a fire-pending plan (independent signals)', () => {
    const actions = recommendMaintenanceActions(
      summary({
        persisted_compactions: { count: 1, consistent_count: 1, inconsistent_count: 0 },
        gc: { candidate_count: 17, safe_to_delete: { count: 17, bytes: 17 * 1024 }, blocked: { count: 0, bytes: 0 } },
        compaction: { empty: false, entity_count: 1, reasons: ['low_count_byte_ceiling'] },
      }),
    )
    expect(actions.map((a) => a.kind)).toEqual(['gc_superseded', 'run_compaction'])
  })

  it('emits `resolve_overlap` as the SOLE recommendation when cross-seq overlaps exist (corruption gate)', () => {
    // Overlap is the highest-priority correctness signal. Even
    // when every other condition is also true, the recommender
    // must emit ONLY the resolve_overlap row and stop — running
    // GC or resuming a merge would compound the damage.
    const actions = recommendMaintenanceActions(
      summary({
        persisted_compactions: { count: 2, consistent_count: 1, inconsistent_count: 1 },
        gc: { candidate_count: 17, safe_to_delete: { count: 17, bytes: 17 * 1024 }, blocked: { count: 0, bytes: 0 } },
        compaction: { empty: false, entity_count: 1, reasons: ['low_count_byte_ceiling'] },
        overlaps: { count: 1, paths: ['epochs/2/projection/sessions.parquet'] },
      }),
    )
    expect(actions).toHaveLength(1)
    expect(actions[0]).toEqual({
      kind: 'resolve_overlap',
      overlap_count: 1,
      paths: ['epochs/2/projection/sessions.parquet'],
    })
  })

  it('emits `resolve_overlap` with every overlapping path surfaced verbatim', () => {
    const paths = [
      'epochs/2/projection/messages.parquet',
      'epochs/5/projection/sessions.parquet',
      'epochs/9/projection/sessions.parquet',
    ]
    const actions = recommendMaintenanceActions(summary({ overlaps: { count: paths.length, paths } }))
    expect(actions).toHaveLength(1)
    expect((actions[0] as { kind: string; paths: string[] }).paths).toEqual(paths)
  })

  it('returns the normal ordered list once overlaps clear (overlap.count === 0)', () => {
    // When overlaps.count is zero, the resolve_overlap branch
    // must NOT short-circuit; the remaining priority order kicks
    // back in.
    const actions = recommendMaintenanceActions(
      summary({
        overlaps: { count: 0, paths: [] },
        persisted_compactions: { count: 1, consistent_count: 0, inconsistent_count: 1 },
        compaction: { empty: false, entity_count: 1, reasons: ['low_count_byte_ceiling'] },
      }),
    )
    expect(actions.map((a) => a.kind)).toEqual(['resume_compaction', 'run_compaction'])
  })
})
