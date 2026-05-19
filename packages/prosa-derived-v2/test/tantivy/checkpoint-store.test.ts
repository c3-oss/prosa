// IndexCheckpointV2 persistence tests.
//
// Exercises the on-disk side of the Tantivy rebuild-planner state
// machine: writing a checkpoint, reading it back, returning null when
// missing, and rejecting malformed input. The on-disk format is
// canonical JSON (sorted keys) so two equivalent checkpoints always
// produce byte-identical files.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  readIndexCheckpoint,
  readIndexCheckpointOrEmpty,
  tantivyCheckpointPath,
  writeIndexCheckpoint,
} from '../../src/tantivy/checkpoint-store.js'
import {
  EMPTY_INDEX_CHECKPOINT,
  type IndexCheckpointV2,
  checkpointAfterRebuild,
} from '../../src/tantivy/rebuild-plan.js'

describe('IndexCheckpointV2 persistence', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-checkpoint-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns null when no checkpoint file exists', async () => {
    const result = await readIndexCheckpoint(bundleRoot)
    expect(result).toBeNull()
  })

  it('readIndexCheckpointOrEmpty returns EMPTY_INDEX_CHECKPOINT when missing', async () => {
    const result = await readIndexCheckpointOrEmpty(bundleRoot)
    expect(result).toEqual(EMPTY_INDEX_CHECKPOINT)
  })

  it('round-trips a populated checkpoint through canonical JSON', async () => {
    const checkpoint = checkpointAfterRebuild({
      prior: EMPTY_INDEX_CHECKPOINT,
      fingerprint: `blake3:${'a'.repeat(64)}`,
      newMaxRowid: 12_345,
      indexedDocCount: 1_001,
      sourceDocCount: 1_001,
    })
    await writeIndexCheckpoint(bundleRoot, checkpoint)
    const round = await readIndexCheckpoint(bundleRoot)
    expect(round).toEqual(checkpoint)
  })

  it('round-trips an EMPTY_INDEX_CHECKPOINT (all-null values)', async () => {
    await writeIndexCheckpoint(bundleRoot, EMPTY_INDEX_CHECKPOINT)
    const round = await readIndexCheckpoint(bundleRoot)
    expect(round).toEqual(EMPTY_INDEX_CHECKPOINT)
  })

  it('persists canonical JSON with sorted keys and no whitespace', async () => {
    const checkpoint: IndexCheckpointV2 = {
      last_indexed_rowid: 42,
      schema_fingerprint: `blake3:${'b'.repeat(64)}`,
      status: 'ready',
      indexed_doc_count: 17,
      source_doc_count: 17,
      error_message: null,
    }
    await writeIndexCheckpoint(bundleRoot, checkpoint)
    const bytes = await readFile(tantivyCheckpointPath(bundleRoot))
    const text = bytes.toString('utf-8')
    // No whitespace.
    expect(text).not.toContain(' ')
    expect(text).not.toContain('\n')
    // Keys appear alphabetically.
    const keyOrder = [...text.matchAll(/"([a-z_]+)":/g)].map((m) => m[1])
    const sorted = [...keyOrder].sort()
    expect(keyOrder).toEqual(sorted)
    // Two equivalent checkpoints serialize to byte-identical files.
    const second = await mkdtemp(join(tmpdir(), 'prosa-derived-checkpoint-'))
    try {
      await writeIndexCheckpoint(second, checkpoint)
      const secondBytes = await readFile(tantivyCheckpointPath(second))
      expect(Buffer.compare(bytes, secondBytes)).toBe(0)
    } finally {
      await rm(second, { recursive: true, force: true })
    }
  })

  it('overwrites a prior checkpoint atomically (newest write wins)', async () => {
    const first = checkpointAfterRebuild({
      prior: EMPTY_INDEX_CHECKPOINT,
      fingerprint: `blake3:${'a'.repeat(64)}`,
      newMaxRowid: 1,
      indexedDocCount: 1,
      sourceDocCount: 1,
    })
    await writeIndexCheckpoint(bundleRoot, first)
    expect(await readIndexCheckpoint(bundleRoot)).toEqual(first)
    const second = checkpointAfterRebuild({
      prior: first,
      fingerprint: `blake3:${'a'.repeat(64)}`,
      newMaxRowid: 999,
      indexedDocCount: 50,
      sourceDocCount: 50,
    })
    await writeIndexCheckpoint(bundleRoot, second)
    expect(await readIndexCheckpoint(bundleRoot)).toEqual(second)
  })

  it('rejects malformed JSON with a useful error', async () => {
    const path = tantivyCheckpointPath(bundleRoot)
    await mkdir(join(bundleRoot, 'derived', 'tantivy'), { recursive: true })
    await writeFile(path, '{not really json')
    await expect(readIndexCheckpoint(bundleRoot)).rejects.toThrow(/malformed JSON/)
  })

  it('rejects a JSON array (not an object)', async () => {
    const path = tantivyCheckpointPath(bundleRoot)
    await mkdir(join(bundleRoot, 'derived', 'tantivy'), { recursive: true })
    await writeFile(path, '[]')
    await expect(readIndexCheckpoint(bundleRoot)).rejects.toThrow(/not a JSON object/)
  })

  it('rejects a checkpoint with a wrong-typed numeric field', async () => {
    const path = tantivyCheckpointPath(bundleRoot)
    await mkdir(join(bundleRoot, 'derived', 'tantivy'), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        ...EMPTY_INDEX_CHECKPOINT,
        last_indexed_rowid: 'one hundred',
      }),
    )
    await expect(readIndexCheckpoint(bundleRoot)).rejects.toThrow(/last_indexed_rowid is not a finite number or null/)
  })

  it('rejects a checkpoint with an unexpected status value', async () => {
    const path = tantivyCheckpointPath(bundleRoot)
    await mkdir(join(bundleRoot, 'derived', 'tantivy'), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        ...EMPTY_INDEX_CHECKPOINT,
        status: 'compiling',
      }),
    )
    await expect(readIndexCheckpoint(bundleRoot)).rejects.toThrow(/status has unexpected value/)
  })
})
