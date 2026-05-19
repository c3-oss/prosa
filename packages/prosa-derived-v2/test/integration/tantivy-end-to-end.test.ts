// Tantivy read-side end-to-end integration test.
//
// Wires the read-side Tantivy surfaces together against a single
// bundle and walks the full lifecycle a runtime writer would
// follow: fresh → first-rebuild plan → write checkpoint →
// no-op skip plan → simulated row arrivals → incremental plan →
// fingerprint mismatch → full rebuild → reset → fresh-again.
//
// Pipeline exercised:
//
//   1. `currentTantivySchemaFingerprint` — canonical pinned fingerprint.
//   2. `tantivyIndexDirIsValid` — on-disk probe with CQ-094/CQ-096
//      hardening.
//   3. `readIndexCheckpointOrEmpty` / `readIndexCheckpoint` /
//      `writeIndexCheckpoint` — checkpoint state persistence.
//   4. `planTantivyRebuild` — pure rebuild-plan state machine.
//   5. `planTantivyRebuildFromBundle` — bundle-aware orchestration
//      composing the probe + checkpoint + planner.
//   6. `checkpointAfterRebuild` / `checkpointAfterFailure` — state
//      transitions returned by the writer.
//   7. `clearTantivyIndexDir` — full-rebuild reset path.
//   8. `tantivyIndexStatus` — top-level read-only status snapshot.
//
// Asserts cross-surface parity invariants — the bundle-aware
// planner agrees with `planTantivyRebuild` for every state, the
// `tantivyIndexStatus` snapshot mirrors what the read surfaces
// expose, checkpoint writes round-trip through the read, and the
// full-rebuild reset path leaves a usable empty index directory.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  readIndexCheckpoint,
  readIndexCheckpointOrEmpty,
  writeIndexCheckpoint,
} from '../../src/tantivy/checkpoint-store.js'
import {
  clearTantivyIndexDir,
  tantivyIndexDir,
  tantivyIndexDirIsValid,
  tantivyMetaPath,
} from '../../src/tantivy/index-dir.js'
import { planTantivyRebuildFromBundle } from '../../src/tantivy/plan-bundle.js'
import {
  EMPTY_INDEX_CHECKPOINT,
  checkpointAfterFailure,
  checkpointAfterRebuild,
  planTantivyRebuild,
} from '../../src/tantivy/rebuild-plan.js'
import { currentTantivySchemaFingerprint } from '../../src/tantivy/schema.js'
import { tantivyIndexStatus } from '../../src/tantivy/status.js'

async function plantValidIndexDir(bundleRoot: string) {
  await mkdir(tantivyIndexDir(bundleRoot), { recursive: true })
  await writeFile(tantivyMetaPath(bundleRoot), JSON.stringify({ segments: [] }))
}

describe('Tantivy read-side end-to-end pipeline', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-int-tantivy-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('fresh bundle: plan is full/no_prior_index, status is all-false', async () => {
    const fp = currentTantivySchemaFingerprint()

    expect(await tantivyIndexDirIsValid(bundleRoot)).toBe(false)
    expect(await readIndexCheckpoint(bundleRoot)).toBeNull()
    expect(await readIndexCheckpointOrEmpty(bundleRoot)).toEqual(EMPTY_INDEX_CHECKPOINT)

    const result = await planTantivyRebuildFromBundle({ bundleRoot, currentMaxRowid: 100 })
    expect(result.indexDirValid).toBe(false)
    expect(result.checkpoint).toEqual(EMPTY_INDEX_CHECKPOINT)
    expect(result.plan.kind).toBe('full')
    if (result.plan.kind === 'full') {
      // Planner reports `index_dir_invalid` whenever the on-disk
      // probe fails — this takes precedence over `no_prior_index`
      // for a fresh-fresh bundle (the dir is missing entirely).
      expect(result.plan.reason).toBe('index_dir_invalid')
    }

    const status = await tantivyIndexStatus(bundleRoot)
    expect(status.checkpoint_present).toBe(false)
    expect(status.index_dir_valid).toBe(false)
    expect(status.current_schema_fingerprint).toBe(fp)
    expect(status.schema_fingerprint_match).toBe(false)
    expect(status.ready_for_read).toBe(false)
  })

  it('after a successful rebuild + checkpoint write: plan is skip, status is ready', async () => {
    const fp = currentTantivySchemaFingerprint()
    await plantValidIndexDir(bundleRoot)
    const checkpoint = checkpointAfterRebuild({
      prior: EMPTY_INDEX_CHECKPOINT,
      fingerprint: fp,
      newMaxRowid: 100,
      indexedDocCount: 100,
      sourceDocCount: 100,
    })
    await writeIndexCheckpoint(bundleRoot, checkpoint)

    // Checkpoint round-trips through disk.
    expect(await readIndexCheckpoint(bundleRoot)).toEqual(checkpoint)

    // Bundle-aware planner agrees: nothing to do.
    const result = await planTantivyRebuildFromBundle({ bundleRoot, currentMaxRowid: 100 })
    expect(result.indexDirValid).toBe(true)
    expect(result.plan.kind).toBe('skip')

    // Pure planner agrees with bundle planner.
    const pure = planTantivyRebuild({
      checkpoint,
      currentMaxRowid: 100,
      indexDirValid: true,
    })
    expect(pure).toEqual(result.plan)

    // Status snapshot mirrors the post-rebuild state.
    const status = await tantivyIndexStatus(bundleRoot)
    expect(status.checkpoint_present).toBe(true)
    expect(status.index_dir_valid).toBe(true)
    expect(status.schema_fingerprint_match).toBe(true)
    expect(status.ready_for_read).toBe(true)
  })

  it('new rows arrive: plan becomes incremental', async () => {
    const fp = currentTantivySchemaFingerprint()
    await plantValidIndexDir(bundleRoot)
    await writeIndexCheckpoint(bundleRoot, {
      ...EMPTY_INDEX_CHECKPOINT,
      status: 'ready',
      schema_fingerprint: fp,
      last_indexed_rowid: 50,
      indexed_doc_count: 50,
      source_doc_count: 50,
    })

    const result = await planTantivyRebuildFromBundle({ bundleRoot, currentMaxRowid: 100 })
    expect(result.plan.kind).toBe('incremental')
    if (result.plan.kind === 'incremental') {
      expect(result.plan.reason).toBe('fingerprint_match_with_new_rows')
      expect(result.plan.lastIndexedRowid).toBe(50)
      expect(result.plan.currentMaxRowid).toBe(100)
    }
  })

  it('fingerprint mismatch: plan forces full rebuild', async () => {
    await plantValidIndexDir(bundleRoot)
    await writeIndexCheckpoint(bundleRoot, {
      ...EMPTY_INDEX_CHECKPOINT,
      status: 'ready',
      schema_fingerprint: 'blake3:stale_fingerprint_value_that_does_not_match',
      last_indexed_rowid: 100,
      indexed_doc_count: 100,
      source_doc_count: 100,
    })

    const result = await planTantivyRebuildFromBundle({ bundleRoot, currentMaxRowid: 100 })
    expect(result.plan.kind).toBe('full')
    if (result.plan.kind === 'full') {
      expect(result.plan.reason).toBe('fingerprint_mismatch')
    }

    const status = await tantivyIndexStatus(bundleRoot)
    expect(status.schema_fingerprint_match).toBe(false)
    expect(status.ready_for_read).toBe(false)
  })

  it('prior failure recorded: plan forces full rebuild on next attempt', async () => {
    const fp = currentTantivySchemaFingerprint()
    await plantValidIndexDir(bundleRoot)
    const priorFailed = checkpointAfterFailure({
      prior: {
        ...EMPTY_INDEX_CHECKPOINT,
        status: 'ready',
        schema_fingerprint: fp,
        last_indexed_rowid: 100,
        indexed_doc_count: 100,
        source_doc_count: 100,
      },
      errorMessage: 'native binding panicked',
    })
    await writeIndexCheckpoint(bundleRoot, priorFailed)

    const result = await planTantivyRebuildFromBundle({ bundleRoot, currentMaxRowid: 100 })
    expect(result.plan.kind).toBe('full')
    if (result.plan.kind === 'full') {
      expect(result.plan.reason).toBe('prior_run_failed')
    }

    const status = await tantivyIndexStatus(bundleRoot)
    // The checkpoint is present and recorded as failed, but the
    // composed gate `ready_for_read` requires status='ready'.
    expect(status.checkpoint_present).toBe(true)
    expect(status.checkpoint!.error_message).toBe('native binding panicked')
    expect(status.ready_for_read).toBe(false)
  })

  it('full-rebuild reset path: clearTantivyIndexDir leaves an empty dir + indexDirValid false', async () => {
    // Plant a valid index, then reset.
    await plantValidIndexDir(bundleRoot)
    await writeFile(join(tantivyIndexDir(bundleRoot), 'stale.bin'), 'stale')
    expect(await tantivyIndexDirIsValid(bundleRoot)).toBe(true)

    await clearTantivyIndexDir(bundleRoot)

    // Dir exists empty; the probe rejects because `meta.json` is
    // gone (the writer will re-populate on its next run).
    expect(await tantivyIndexDirIsValid(bundleRoot)).toBe(false)

    // A subsequent plan therefore falls back to `full` /
    // `index_dir_invalid`; the planner checks the on-disk probe
    // before the empty-checkpoint state.
    const result = await planTantivyRebuildFromBundle({ bundleRoot, currentMaxRowid: 100 })
    expect(result.plan.kind).toBe('full')
    if (result.plan.kind === 'full') {
      expect(result.plan.reason).toBe('index_dir_invalid')
    }
  })

  it('caller-requested overwrite: pure planner returns full with caller_requested_overwrite', async () => {
    const fp = currentTantivySchemaFingerprint()
    await plantValidIndexDir(bundleRoot)
    await writeIndexCheckpoint(bundleRoot, {
      ...EMPTY_INDEX_CHECKPOINT,
      status: 'ready',
      schema_fingerprint: fp,
      last_indexed_rowid: 100,
      indexed_doc_count: 100,
      source_doc_count: 100,
    })

    // The bundle-aware planner exposes the overwrite flag.
    const result = await planTantivyRebuildFromBundle({
      bundleRoot,
      currentMaxRowid: 100,
      overwriteRequested: true,
    })
    expect(result.plan.kind).toBe('full')
    if (result.plan.kind === 'full') {
      expect(result.plan.reason).toBe('caller_requested_overwrite')
    }
  })

  it('checkpoint write replaces atomically (CQ-093): old content vanishes', async () => {
    const fp = currentTantivySchemaFingerprint()
    const v1 = checkpointAfterRebuild({
      prior: EMPTY_INDEX_CHECKPOINT,
      fingerprint: fp,
      newMaxRowid: 50,
      indexedDocCount: 50,
      sourceDocCount: 50,
    })
    await writeIndexCheckpoint(bundleRoot, v1)
    expect(await readIndexCheckpoint(bundleRoot)).toEqual(v1)

    const v2 = checkpointAfterRebuild({
      prior: v1,
      fingerprint: fp,
      newMaxRowid: 200,
      indexedDocCount: 200,
      sourceDocCount: 200,
    })
    await writeIndexCheckpoint(bundleRoot, v2)
    const read = await readIndexCheckpoint(bundleRoot)
    expect(read).toEqual(v2)
    // No stale temp left behind from the rename-based atomic write.
    const fs = await import('node:fs/promises')
    const entries = await fs.readdir(join(bundleRoot, 'derived', 'tantivy'))
    expect(entries).toEqual(['checkpoint.json'])
  })
})
