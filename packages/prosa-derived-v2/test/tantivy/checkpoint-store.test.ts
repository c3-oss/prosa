// IndexCheckpointV2 persistence tests.
//
// Exercises the on-disk side of the Tantivy rebuild-planner state
// machine: writing a checkpoint, reading it back, returning null when
// missing, and rejecting malformed input. The on-disk format is
// canonical JSON (sorted keys) so two equivalent checkpoints always
// produce byte-identical files.

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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

  it('replaces a prior checkpoint via rename, leaving no stale temp behind', async () => {
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
    // After a successful write there must be exactly one file in the
    // checkpoint directory: the final `checkpoint.json`. No `.tmp.*`
    // siblings may survive the rename path.
    const entries = await readdir(join(bundleRoot, 'derived', 'tantivy'))
    expect(entries).toEqual(['checkpoint.json'])
  })

  it('CQ-093: a stale `.tmp.*` file from an interrupted prior update does not corrupt the next read', async () => {
    // Simulate a previous run that crashed between writing the temp
    // file and the rename: the prior good `checkpoint.json` is still
    // on disk, and a leftover `.tmp.<pid>.<rand>` sits beside it.
    const good = checkpointAfterRebuild({
      prior: EMPTY_INDEX_CHECKPOINT,
      fingerprint: `blake3:${'a'.repeat(64)}`,
      newMaxRowid: 42,
      indexedDocCount: 5,
      sourceDocCount: 5,
    })
    await writeIndexCheckpoint(bundleRoot, good)
    expect(await readIndexCheckpoint(bundleRoot)).toEqual(good)
    const path = tantivyCheckpointPath(bundleRoot)
    const dir = join(bundleRoot, 'derived', 'tantivy')
    // Plant a stale temp file with garbage bytes — what a crash
    // mid-write would leave behind.
    const stalePath = `${path}.tmp.999999.deadbeef`
    await writeFile(stalePath, 'partial-write-garbage')
    // Reads must still return the prior good checkpoint — the temp
    // file does not shadow the final path.
    expect(await readIndexCheckpoint(bundleRoot)).toEqual(good)
    // The next successful write must replace `checkpoint.json` via a
    // fresh rename, must not touch the stale temp, and must leave the
    // final path readable as the new checkpoint.
    const next = checkpointAfterRebuild({
      prior: good,
      fingerprint: `blake3:${'a'.repeat(64)}`,
      newMaxRowid: 100,
      indexedDocCount: 10,
      sourceDocCount: 10,
    })
    await writeIndexCheckpoint(bundleRoot, next)
    expect(await readIndexCheckpoint(bundleRoot)).toEqual(next)
    // The stale temp from the simulated prior crash is still there
    // (we deliberately do not delete files we did not create), but
    // it must not have been swapped onto the final path.
    const entries = (await readdir(dir)).sort()
    expect(entries).toContain('checkpoint.json')
    expect(entries).toContain('checkpoint.json.tmp.999999.deadbeef')
    // The new write's own temp file is gone — proof the rename path
    // cleaned up after itself.
    for (const entry of entries) {
      if (entry === 'checkpoint.json.tmp.999999.deadbeef') continue
      if (entry === 'checkpoint.json') continue
      // Any other entry would be a fresh stale temp, which would
      // signal a bug in the rename cleanup.
      throw new Error(`unexpected entry in checkpoint dir after rename: ${entry}`)
    }
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
