// Tantivy rebuild planner tests.

import { describe, expect, it } from 'vitest'

import {
  EMPTY_INDEX_CHECKPOINT,
  type IndexCheckpointV2,
  checkpointAfterFailure,
  checkpointAfterRebuild,
  planTantivyRebuild,
} from '../../src/tantivy/rebuild-plan.js'
import { currentTantivySchemaFingerprint } from '../../src/tantivy/schema.js'

const FINGERPRINT = currentTantivySchemaFingerprint()

function withCheckpoint(overrides: Partial<IndexCheckpointV2>): IndexCheckpointV2 {
  return { ...EMPTY_INDEX_CHECKPOINT, ...overrides }
}

describe('planTantivyRebuild', () => {
  it('full rebuild when no prior checkpoint exists (fresh bundle)', () => {
    const plan = planTantivyRebuild({
      checkpoint: EMPTY_INDEX_CHECKPOINT,
      currentMaxRowid: 0,
      indexDirValid: false,
    })
    expect(plan.kind).toBe('full')
    if (plan.kind === 'full') expect(plan.reason).toBe('index_dir_invalid')
  })

  it('full rebuild when `--overwrite` is requested even if everything else matches', () => {
    const plan = planTantivyRebuild({
      checkpoint: withCheckpoint({
        last_indexed_rowid: 100,
        schema_fingerprint: FINGERPRINT,
        status: 'ready',
      }),
      currentMaxRowid: 100,
      indexDirValid: true,
      overwriteRequested: true,
    })
    expect(plan.kind).toBe('full')
    if (plan.kind === 'full') expect(plan.reason).toBe('caller_requested_overwrite')
  })

  it('full rebuild when fingerprint stored in the checkpoint differs from current', () => {
    const plan = planTantivyRebuild({
      checkpoint: withCheckpoint({
        last_indexed_rowid: 50,
        schema_fingerprint: 'blake3:0000000000000000000000000000000000000000000000000000000000000000',
        status: 'ready',
      }),
      currentMaxRowid: 75,
      indexDirValid: true,
    })
    expect(plan.kind).toBe('full')
    if (plan.kind === 'full') expect(plan.reason).toBe('fingerprint_mismatch')
  })

  it('full rebuild when prior run is marked failed', () => {
    const plan = planTantivyRebuild({
      checkpoint: withCheckpoint({
        last_indexed_rowid: 5,
        schema_fingerprint: FINGERPRINT,
        status: 'failed',
        error_message: 'oops',
      }),
      currentMaxRowid: 5,
      indexDirValid: true,
    })
    expect(plan.kind).toBe('full')
    if (plan.kind === 'full') expect(plan.reason).toBe('prior_run_failed')
  })

  it('full rebuild when prior checkpoint has no indexed rowid (last_indexed_rowid <= 0)', () => {
    const plan = planTantivyRebuild({
      checkpoint: withCheckpoint({
        last_indexed_rowid: 0,
        schema_fingerprint: FINGERPRINT,
        status: 'ready',
      }),
      currentMaxRowid: 10,
      indexDirValid: true,
    })
    expect(plan.kind).toBe('full')
    if (plan.kind === 'full') expect(plan.reason).toBe('no_prior_index')
  })

  it('incremental append when fingerprint matches and new rows have arrived', () => {
    const plan = planTantivyRebuild({
      checkpoint: withCheckpoint({
        last_indexed_rowid: 100,
        schema_fingerprint: FINGERPRINT,
        status: 'ready',
      }),
      currentMaxRowid: 150,
      indexDirValid: true,
    })
    expect(plan.kind).toBe('incremental')
    if (plan.kind === 'incremental') {
      expect(plan.lastIndexedRowid).toBe(100)
      expect(plan.currentMaxRowid).toBe(150)
      expect(plan.reason).toBe('fingerprint_match_with_new_rows')
    }
  })

  it('skip when fingerprint matches, no new rows, and status is ready', () => {
    const plan = planTantivyRebuild({
      checkpoint: withCheckpoint({
        last_indexed_rowid: 100,
        schema_fingerprint: FINGERPRINT,
        status: 'ready',
      }),
      currentMaxRowid: 100,
      indexDirValid: true,
    })
    expect(plan.kind).toBe('skip')
    if (plan.kind === 'skip') expect(plan.reason).toBe('already_indexed_up_to_date')
  })

  it('incremental even when checkpoint is not ready, as long as there are new rows + fingerprint match', () => {
    // status='idle' with last_indexed_rowid > 0 and new rows → incremental.
    const plan = planTantivyRebuild({
      checkpoint: withCheckpoint({
        last_indexed_rowid: 50,
        schema_fingerprint: FINGERPRINT,
        status: 'idle',
      }),
      currentMaxRowid: 60,
      indexDirValid: true,
    })
    expect(plan.kind).toBe('incremental')
  })

  it('CQ-115: full / epoch_mismatch when caller passes a currentEpoch that differs from the checkpoint epoch', () => {
    const plan = planTantivyRebuild({
      checkpoint: withCheckpoint({
        last_indexed_rowid: 10,
        last_indexed_epoch: 0,
        schema_fingerprint: FINGERPRINT,
        status: 'ready',
      }),
      currentMaxRowid: 5,
      indexDirValid: true,
      currentEpoch: 1,
    })
    expect(plan.kind).toBe('full')
    if (plan.kind !== 'full') throw new Error('unreachable')
    expect(plan.reason).toBe('epoch_mismatch')
  })

  it('CQ-115: full / epoch_mismatch when the checkpoint records a prior ready run but no last_indexed_epoch', () => {
    const plan = planTantivyRebuild({
      checkpoint: withCheckpoint({
        last_indexed_rowid: 10,
        last_indexed_epoch: null,
        schema_fingerprint: FINGERPRINT,
        status: 'ready',
      }),
      currentMaxRowid: 5,
      indexDirValid: true,
      currentEpoch: 0,
    })
    expect(plan.kind).toBe('full')
    if (plan.kind !== 'full') throw new Error('unreachable')
    expect(plan.reason).toBe('epoch_mismatch')
  })

  it('CQ-115: matching currentEpoch lets the planner reach skip / incremental as before', () => {
    const skipPlan = planTantivyRebuild({
      checkpoint: withCheckpoint({
        last_indexed_rowid: 10,
        last_indexed_epoch: 2,
        schema_fingerprint: FINGERPRINT,
        status: 'ready',
      }),
      currentMaxRowid: 10,
      indexDirValid: true,
      currentEpoch: 2,
    })
    expect(skipPlan.kind).toBe('skip')

    const incPlan = planTantivyRebuild({
      checkpoint: withCheckpoint({
        last_indexed_rowid: 10,
        last_indexed_epoch: 2,
        schema_fingerprint: FINGERPRINT,
        status: 'ready',
      }),
      currentMaxRowid: 15,
      indexDirValid: true,
      currentEpoch: 2,
    })
    expect(incPlan.kind).toBe('incremental')
  })

  it('CQ-115: omitting currentEpoch keeps the pre-CQ-115 behaviour (legacy callers unaffected)', () => {
    const plan = planTantivyRebuild({
      checkpoint: withCheckpoint({
        last_indexed_rowid: 10,
        last_indexed_epoch: null,
        schema_fingerprint: FINGERPRINT,
        status: 'ready',
      }),
      currentMaxRowid: 10,
      indexDirValid: true,
    })
    expect(plan.kind).toBe('skip')
  })
})

describe('checkpointAfterRebuild / checkpointAfterFailure', () => {
  it('checkpointAfterRebuild overwrites status, fingerprint, rowid, and counts; clears error', () => {
    const next = checkpointAfterRebuild({
      prior: withCheckpoint({
        status: 'failed',
        error_message: 'previous error',
        last_indexed_rowid: 10,
      }),
      fingerprint: FINGERPRINT,
      newMaxRowid: 200,
      indexedDocCount: 200,
      sourceDocCount: 200,
    })
    expect(next.status).toBe('ready')
    expect(next.schema_fingerprint).toBe(FINGERPRINT)
    expect(next.last_indexed_rowid).toBe(200)
    expect(next.indexed_doc_count).toBe(200)
    expect(next.source_doc_count).toBe(200)
    expect(next.error_message).toBeNull()
  })

  it('checkpointAfterRebuild records the new epoch when passed and preserves the prior epoch when omitted (CQ-115)', () => {
    const withEpoch = checkpointAfterRebuild({
      prior: withCheckpoint({ last_indexed_epoch: null }),
      fingerprint: FINGERPRINT,
      newMaxRowid: 5,
      indexedDocCount: 5,
      sourceDocCount: 5,
      epoch: 3,
    })
    expect(withEpoch.last_indexed_epoch).toBe(3)

    const withoutEpoch = checkpointAfterRebuild({
      prior: withCheckpoint({ last_indexed_epoch: 7 }),
      fingerprint: FINGERPRINT,
      newMaxRowid: 5,
      indexedDocCount: 5,
      sourceDocCount: 5,
    })
    expect(withoutEpoch.last_indexed_epoch).toBe(7)
  })

  it('checkpointAfterFailure preserves prior data and records the error', () => {
    const next = checkpointAfterFailure({
      prior: withCheckpoint({
        status: 'ready',
        schema_fingerprint: FINGERPRINT,
        last_indexed_rowid: 100,
        indexed_doc_count: 100,
        source_doc_count: 100,
      }),
      errorMessage: 'tantivy crashed mid-commit',
    })
    expect(next.status).toBe('failed')
    expect(next.error_message).toBe('tantivy crashed mid-commit')
    // Prior data preserved.
    expect(next.last_indexed_rowid).toBe(100)
    expect(next.schema_fingerprint).toBe(FINGERPRINT)
    expect(next.indexed_doc_count).toBe(100)
  })
})
