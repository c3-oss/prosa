// IndexCheckpointV2 persistence tests.
//
// Exercises the on-disk side of the Tantivy rebuild-planner state
// machine: writing a checkpoint, reading it back, returning null when
// missing, and rejecting malformed input. The on-disk format is
// canonical JSON (sorted keys) so two equivalent checkpoints always
// produce byte-identical files.

import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
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

  describe('CQ-096-parallel write-side containment', () => {
    const VALID_CHECKPOINT: IndexCheckpointV2 = {
      ...EMPTY_INDEX_CHECKPOINT,
      status: 'ready',
      schema_fingerprint: 'blake3:0000000000000000000000000000000000000000000000000000000000000000',
      last_indexed_rowid: 1,
      indexed_doc_count: 1,
      source_doc_count: 1,
    }

    it('refuses to write when `<bundleRoot>/derived/tantivy` is a symlink (must not redirect mkdir)', async () => {
      const external = await mkdtemp(join(tmpdir(), 'prosa-derived-checkpoint-cq096-tantivy-'))
      try {
        await mkdir(join(bundleRoot, 'derived'), { recursive: true })
        await symlink(external, join(bundleRoot, 'derived', 'tantivy'))

        await expect(writeIndexCheckpoint(bundleRoot, VALID_CHECKPOINT)).rejects.toThrow(/CQ-096|symlink|intermediate/i)
        // External target survives without a `checkpoint.json` planted in it.
        const externalEntries = await readdir(external)
        expect(externalEntries).toEqual([])
        // The symlink itself is left in place for the operator to investigate.
        const linkStat = await lstat(join(bundleRoot, 'derived', 'tantivy'))
        expect(linkStat.isSymbolicLink()).toBe(true)
      } finally {
        await rm(external, { recursive: true, force: true })
      }
    })

    it('refuses to write when `<bundleRoot>/derived` is a symlink (outermost intermediate)', async () => {
      const external = await mkdtemp(join(tmpdir(), 'prosa-derived-checkpoint-cq096-derived-'))
      try {
        await writeFile(join(external, 'sentinel'), 'do not touch')
        await symlink(external, join(bundleRoot, 'derived'))

        await expect(writeIndexCheckpoint(bundleRoot, VALID_CHECKPOINT)).rejects.toThrow(/CQ-096|symlink|intermediate/i)
        // External tree's sentinel survives unchanged.
        expect(await readFile(join(external, 'sentinel'), 'utf-8')).toBe('do not touch')
      } finally {
        await rm(external, { recursive: true, force: true })
      }
    })

    it('accepts a symlinked bundle-root alias when the derived/tantivy chain is real', async () => {
      // Bundle-root containment is NOT validated — the symlinked-
      // bundle-root deployment pattern stays supported.
      const aliasParent = await mkdtemp(join(tmpdir(), 'prosa-derived-checkpoint-cq096-alias-'))
      try {
        const aliasRoot = join(aliasParent, 'bundle-alias')
        await symlink(bundleRoot, aliasRoot)

        await writeIndexCheckpoint(aliasRoot, VALID_CHECKPOINT)

        // Checkpoint actually landed under the real bundle root.
        expect(await readIndexCheckpoint(bundleRoot)).toEqual(VALID_CHECKPOINT)
      } finally {
        await rm(aliasParent, { recursive: true, force: true })
      }
    })

    it('continues to work on a fresh bundle (no intermediate-symlink false positives)', async () => {
      // The fresh-bundle case has no `derived/` directory at all;
      // the containment check tolerates ENOENT and the write
      // proceeds to create the dir + checkpoint normally.
      await writeIndexCheckpoint(bundleRoot, VALID_CHECKPOINT)
      expect(await readIndexCheckpoint(bundleRoot)).toEqual(VALID_CHECKPOINT)
    })
  })

  describe('CQ-103: read-side symlink containment', () => {
    const VALID_CHECKPOINT: IndexCheckpointV2 = {
      ...EMPTY_INDEX_CHECKPOINT,
      status: 'ready',
      schema_fingerprint: `blake3:${'c'.repeat(64)}`,
      last_indexed_rowid: 7,
      indexed_doc_count: 7,
      source_doc_count: 7,
    }

    it('refuses to read when `<bundleRoot>/derived/tantivy` is a symlink (intermediate)', async () => {
      const external = await mkdtemp(join(tmpdir(), 'prosa-derived-checkpoint-cq103-tantivy-'))
      try {
        // External target has a perfectly valid checkpoint.json that
        // would otherwise round-trip — the read must still refuse.
        await writeFile(
          join(external, 'checkpoint.json'),
          JSON.stringify({
            error_message: null,
            indexed_doc_count: 99,
            last_indexed_rowid: 99,
            schema_fingerprint: 'blake3:fake',
            source_doc_count: 99,
            status: 'ready',
          }),
        )
        await mkdir(join(bundleRoot, 'derived'), { recursive: true })
        await symlink(external, join(bundleRoot, 'derived', 'tantivy'))

        await expect(readIndexCheckpoint(bundleRoot)).rejects.toThrow(/CQ-103|symlink|intermediate/i)
      } finally {
        await rm(external, { recursive: true, force: true })
      }
    })

    it('refuses to read when `<bundleRoot>/derived` is a symlink (outermost intermediate)', async () => {
      const external = await mkdtemp(join(tmpdir(), 'prosa-derived-checkpoint-cq103-derived-'))
      try {
        await symlink(external, join(bundleRoot, 'derived'))

        await expect(readIndexCheckpoint(bundleRoot)).rejects.toThrow(/CQ-103|symlink|intermediate/i)
      } finally {
        await rm(external, { recursive: true, force: true })
      }
    })

    it('refuses to read when the final `checkpoint.json` is a symlink', async () => {
      // Real derived/tantivy/ but the final checkpoint.json is a
      // symlink to an external file. The read must reject before
      // following the link — even if the target is valid JSON, the
      // contents are from outside the bundle.
      await mkdir(join(bundleRoot, 'derived', 'tantivy'), { recursive: true })
      const external = await mkdtemp(join(tmpdir(), 'prosa-derived-checkpoint-cq103-final-'))
      try {
        const externalPath = join(external, 'external-checkpoint.json')
        await writeFile(
          externalPath,
          JSON.stringify({
            error_message: null,
            indexed_doc_count: 1,
            last_indexed_rowid: 1,
            schema_fingerprint: 'blake3:external',
            source_doc_count: 1,
            status: 'ready',
          }),
        )
        await symlink(externalPath, tantivyCheckpointPath(bundleRoot))

        await expect(readIndexCheckpoint(bundleRoot)).rejects.toThrow(/CQ-103|symlink|final path/i)
      } finally {
        await rm(external, { recursive: true, force: true })
      }
    })

    it('refuses to read when the checkpoint path is a directory (non-regular-file)', async () => {
      // Someone planted a directory where the checkpoint should be;
      // the read must reject rather than silently returning null.
      await mkdir(tantivyCheckpointPath(bundleRoot), { recursive: true })
      await expect(readIndexCheckpoint(bundleRoot)).rejects.toThrow(/not a regular file/i)
    })

    it('accepts a symlinked bundle-root alias when the derived/tantivy/checkpoint chain is real', async () => {
      // Bundle-root containment is NOT validated — symlinked
      // bundle-root deployments stay supported. Write through the
      // real root, read through the alias — should round-trip.
      await writeIndexCheckpoint(bundleRoot, VALID_CHECKPOINT)
      const aliasParent = await mkdtemp(join(tmpdir(), 'prosa-derived-checkpoint-cq103-alias-'))
      try {
        const aliasRoot = join(aliasParent, 'bundle-alias')
        await symlink(bundleRoot, aliasRoot)
        const result = await readIndexCheckpoint(aliasRoot)
        expect(result).toEqual(VALID_CHECKPOINT)
      } finally {
        await rm(aliasParent, { recursive: true, force: true })
      }
    })

    it('readIndexCheckpointOrEmpty propagates the same CQ-103 refusal', async () => {
      const external = await mkdtemp(join(tmpdir(), 'prosa-derived-checkpoint-cq103-empty-'))
      try {
        await symlink(external, join(bundleRoot, 'derived'))
        await expect(readIndexCheckpointOrEmpty(bundleRoot)).rejects.toThrow(/CQ-103|symlink|intermediate/i)
      } finally {
        await rm(external, { recursive: true, force: true })
      }
    })
  })
})
