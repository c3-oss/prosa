// planTantivyRebuildFromBundle integration tests.
//
// The orchestration helper wraps three lower-level calls
// (`readIndexCheckpointOrEmpty`, `tantivyIndexDirIsValid`,
// `planTantivyRebuild`) into one async call. The tests cover the
// branches exercised through that helper rather than re-testing the
// underlying primitives.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EMPTY_INDEX_CHECKPOINT, checkpointAfterRebuild, currentTantivySchemaFingerprint } from '../../src/index.js'
import { writeIndexCheckpoint } from '../../src/tantivy/checkpoint-store.js'
import { tantivyIndexDir, tantivyMetaPath } from '../../src/tantivy/index-dir.js'
import { planTantivyRebuildFromBundle } from '../../src/tantivy/plan-bundle.js'

async function plantValidIndex(bundleRoot: string): Promise<void> {
  await mkdir(tantivyIndexDir(bundleRoot), { recursive: true })
  await writeFile(tantivyMetaPath(bundleRoot), JSON.stringify({ segments: [] }))
}

describe('planTantivyRebuildFromBundle', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-tantivy-plan-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns `full` with `no_prior_index` for a fresh bundle (no checkpoint, no index dir)', async () => {
    const { plan, checkpoint, indexDirValid } = await planTantivyRebuildFromBundle({
      bundleRoot,
      currentMaxRowid: 0,
    })
    expect(plan.kind).toBe('full')
    expect(plan.kind === 'full' ? plan.reason : null).toBe('index_dir_invalid')
    expect(checkpoint).toEqual(EMPTY_INDEX_CHECKPOINT)
    expect(indexDirValid).toBe(false)
  })

  it('returns `full` with `no_prior_index` when the index dir is valid but no checkpoint exists', async () => {
    await plantValidIndex(bundleRoot)
    const { plan, checkpoint, indexDirValid } = await planTantivyRebuildFromBundle({
      bundleRoot,
      currentMaxRowid: 100,
    })
    expect(indexDirValid).toBe(true)
    expect(checkpoint).toEqual(EMPTY_INDEX_CHECKPOINT)
    expect(plan.kind).toBe('full')
    expect(plan.kind === 'full' ? plan.reason : null).toBe('no_prior_index')
  })

  it('returns `skip` / `already_indexed_up_to_date` when the checkpoint matches and no new rows arrived', async () => {
    await plantValidIndex(bundleRoot)
    const fingerprint = currentTantivySchemaFingerprint()
    const checkpoint = checkpointAfterRebuild({
      prior: EMPTY_INDEX_CHECKPOINT,
      fingerprint,
      newMaxRowid: 100,
      indexedDocCount: 100,
      sourceDocCount: 100,
    })
    await writeIndexCheckpoint(bundleRoot, checkpoint)

    const result = await planTantivyRebuildFromBundle({ bundleRoot, currentMaxRowid: 100 })
    expect(result.indexDirValid).toBe(true)
    expect(result.checkpoint).toEqual(checkpoint)
    expect(result.plan.kind).toBe('skip')
  })

  it('returns `incremental` when the checkpoint matches and new rows arrived', async () => {
    await plantValidIndex(bundleRoot)
    const fingerprint = currentTantivySchemaFingerprint()
    const checkpoint = checkpointAfterRebuild({
      prior: EMPTY_INDEX_CHECKPOINT,
      fingerprint,
      newMaxRowid: 100,
      indexedDocCount: 100,
      sourceDocCount: 100,
    })
    await writeIndexCheckpoint(bundleRoot, checkpoint)

    const result = await planTantivyRebuildFromBundle({ bundleRoot, currentMaxRowid: 200 })
    expect(result.plan.kind).toBe('incremental')
    if (result.plan.kind === 'incremental') {
      expect(result.plan.lastIndexedRowid).toBe(100)
      expect(result.plan.currentMaxRowid).toBe(200)
    }
  })

  it('returns `full` / `fingerprint_mismatch` when the stored fingerprint diverges from the current schema', async () => {
    await plantValidIndex(bundleRoot)
    const stale = checkpointAfterRebuild({
      prior: EMPTY_INDEX_CHECKPOINT,
      fingerprint: `blake3:${'0'.repeat(64)}`,
      newMaxRowid: 50,
      indexedDocCount: 50,
      sourceDocCount: 50,
    })
    await writeIndexCheckpoint(bundleRoot, stale)

    const result = await planTantivyRebuildFromBundle({ bundleRoot, currentMaxRowid: 200 })
    expect(result.plan.kind).toBe('full')
    if (result.plan.kind === 'full') expect(result.plan.reason).toBe('fingerprint_mismatch')
  })

  it('forces `full` / `caller_requested_overwrite` when `overwriteRequested: true`', async () => {
    await plantValidIndex(bundleRoot)
    const fingerprint = currentTantivySchemaFingerprint()
    const checkpoint = checkpointAfterRebuild({
      prior: EMPTY_INDEX_CHECKPOINT,
      fingerprint,
      newMaxRowid: 100,
      indexedDocCount: 100,
      sourceDocCount: 100,
    })
    await writeIndexCheckpoint(bundleRoot, checkpoint)

    const result = await planTantivyRebuildFromBundle({
      bundleRoot,
      currentMaxRowid: 100,
      overwriteRequested: true,
    })
    expect(result.plan.kind).toBe('full')
    if (result.plan.kind === 'full') expect(result.plan.reason).toBe('caller_requested_overwrite')
  })

  it('returns `full` / `index_dir_invalid` when the checkpoint is valid but the index dir is gone', async () => {
    // Checkpoint says we indexed 100 rows previously, but the index
    // directory has been blown away (e.g., manual cleanup). Planner
    // must force a full rebuild rather than trust the checkpoint.
    const fingerprint = currentTantivySchemaFingerprint()
    const checkpoint = checkpointAfterRebuild({
      prior: EMPTY_INDEX_CHECKPOINT,
      fingerprint,
      newMaxRowid: 100,
      indexedDocCount: 100,
      sourceDocCount: 100,
    })
    await writeIndexCheckpoint(bundleRoot, checkpoint)

    const result = await planTantivyRebuildFromBundle({ bundleRoot, currentMaxRowid: 200 })
    expect(result.indexDirValid).toBe(false)
    expect(result.plan.kind).toBe('full')
    if (result.plan.kind === 'full') expect(result.plan.reason).toBe('index_dir_invalid')
  })

  it('returns `full` / `prior_run_failed` when the checkpoint records a failed run', async () => {
    await plantValidIndex(bundleRoot)
    const fingerprint = currentTantivySchemaFingerprint()
    const failedCheckpoint = {
      ...EMPTY_INDEX_CHECKPOINT,
      schema_fingerprint: fingerprint,
      last_indexed_rowid: 50,
      status: 'failed' as const,
      error_message: 'simulated',
    }
    await writeIndexCheckpoint(bundleRoot, failedCheckpoint)

    const result = await planTantivyRebuildFromBundle({ bundleRoot, currentMaxRowid: 100 })
    expect(result.plan.kind).toBe('full')
    if (result.plan.kind === 'full') expect(result.plan.reason).toBe('prior_run_failed')
  })

  it('propagates the corrupt-checkpoint error from `readIndexCheckpointOrEmpty`', async () => {
    // Plant garbage at the checkpoint path. The underlying read
    // throws on malformed JSON (rather than papering over corruption
    // with EMPTY_INDEX_CHECKPOINT), and the orchestration helper
    // surfaces that error unchanged.
    await mkdir(join(bundleRoot, 'derived', 'tantivy'), { recursive: true })
    await writeFile(join(bundleRoot, 'derived', 'tantivy', 'checkpoint.json'), '{not really json')

    await expect(planTantivyRebuildFromBundle({ bundleRoot, currentMaxRowid: 0 })).rejects.toThrow(/malformed JSON/)
  })
})
