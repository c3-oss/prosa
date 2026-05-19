// Tantivy index-status reader tests.
//
// `tantivyIndexStatus(bundleRoot)` aggregates the checkpoint reader,
// the index-dir probe, and the current schema fingerprint into one
// status snapshot suitable for `prosa index-v2 status` CLI and MCP
// `read_index_status` consumers.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { derivedPaths } from '../../src/derived-layout.js'
import { tantivyCheckpointPath, writeIndexCheckpoint } from '../../src/tantivy/checkpoint-store.js'
import { tantivyIndexDir, tantivyMetaPath } from '../../src/tantivy/index-dir.js'
import { EMPTY_INDEX_CHECKPOINT, type IndexCheckpointV2 } from '../../src/tantivy/rebuild-plan.js'
import { currentTantivySchemaFingerprint } from '../../src/tantivy/schema.js'
import { tantivyIndexStatus } from '../../src/tantivy/status.js'

async function plantValidIndexDir(bundleRoot: string) {
  await mkdir(tantivyIndexDir(bundleRoot), { recursive: true })
  await writeFile(tantivyMetaPath(bundleRoot), JSON.stringify({ segments: [] }))
}

describe('tantivyIndexStatus', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-tantivy-status-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns all-false on a fresh bundle (no checkpoint, no index dir)', async () => {
    const status = await tantivyIndexStatus(bundleRoot)

    expect(status.checkpoint_present).toBe(false)
    expect(status.checkpoint).toBeNull()
    expect(status.index_dir_valid).toBe(false)
    expect(status.current_schema_fingerprint).toBe(currentTantivySchemaFingerprint())
    expect(status.schema_fingerprint_match).toBe(false)
    expect(status.ready_for_read).toBe(false)
  })

  it('reports `index_dir_valid` true when the on-disk index has a parseable meta.json', async () => {
    await plantValidIndexDir(bundleRoot)
    const status = await tantivyIndexStatus(bundleRoot)
    expect(status.index_dir_valid).toBe(true)
    // No checkpoint yet — every other gate stays false.
    expect(status.checkpoint_present).toBe(false)
    expect(status.ready_for_read).toBe(false)
  })

  it('returns the checkpoint snapshot when one is present', async () => {
    const checkpoint: IndexCheckpointV2 = {
      last_indexed_rowid: 100,
      schema_fingerprint: currentTantivySchemaFingerprint(),
      status: 'ready',
      indexed_doc_count: 100,
      source_doc_count: 100,
      error_message: null,
    }
    await writeIndexCheckpoint(bundleRoot, checkpoint)

    const status = await tantivyIndexStatus(bundleRoot)

    expect(status.checkpoint_present).toBe(true)
    expect(status.checkpoint).toEqual(checkpoint)
    expect(status.schema_fingerprint_match).toBe(true)
  })

  it('returns `schema_fingerprint_match: false` when the checkpoint carries a stale fingerprint', async () => {
    const checkpoint: IndexCheckpointV2 = {
      ...EMPTY_INDEX_CHECKPOINT,
      schema_fingerprint: 'blake3:0000000000000000000000000000000000000000000000000000000000000000',
      status: 'ready',
      indexed_doc_count: 5,
      source_doc_count: 5,
      last_indexed_rowid: 5,
    }
    await writeIndexCheckpoint(bundleRoot, checkpoint)

    const status = await tantivyIndexStatus(bundleRoot)

    expect(status.checkpoint_present).toBe(true)
    expect(status.schema_fingerprint_match).toBe(false)
    expect(status.ready_for_read).toBe(false)
  })

  it('returns `ready_for_read: true` only when every gate passes', async () => {
    await plantValidIndexDir(bundleRoot)
    await writeIndexCheckpoint(bundleRoot, {
      last_indexed_rowid: 100,
      schema_fingerprint: currentTantivySchemaFingerprint(),
      status: 'ready',
      indexed_doc_count: 100,
      source_doc_count: 100,
      error_message: null,
    })

    const status = await tantivyIndexStatus(bundleRoot)

    expect(status.checkpoint_present).toBe(true)
    expect(status.index_dir_valid).toBe(true)
    expect(status.schema_fingerprint_match).toBe(true)
    expect(status.ready_for_read).toBe(true)
  })

  it('returns `ready_for_read: false` when status is not "ready" even if dir is valid', async () => {
    await plantValidIndexDir(bundleRoot)
    await writeIndexCheckpoint(bundleRoot, {
      last_indexed_rowid: 50,
      schema_fingerprint: currentTantivySchemaFingerprint(),
      status: 'building',
      indexed_doc_count: 50,
      source_doc_count: 100,
      error_message: null,
    })

    const status = await tantivyIndexStatus(bundleRoot)
    expect(status.checkpoint!.status).toBe('building')
    expect(status.ready_for_read).toBe(false)
  })

  it('returns `ready_for_read: false` when the checkpoint records a prior failure', async () => {
    await plantValidIndexDir(bundleRoot)
    await writeIndexCheckpoint(bundleRoot, {
      last_indexed_rowid: null,
      schema_fingerprint: currentTantivySchemaFingerprint(),
      status: 'failed',
      indexed_doc_count: null,
      source_doc_count: 100,
      error_message: 'native binding panicked',
    })

    const status = await tantivyIndexStatus(bundleRoot)
    expect(status.checkpoint!.error_message).toBe('native binding panicked')
    expect(status.ready_for_read).toBe(false)
  })

  it('returns `ready_for_read: false` when the index dir is missing even if the checkpoint says ready', async () => {
    // Checkpoint says ready, but no on-disk index dir at all (e.g.
    // disk wiped after the checkpoint was last persisted).
    await writeIndexCheckpoint(bundleRoot, {
      last_indexed_rowid: 100,
      schema_fingerprint: currentTantivySchemaFingerprint(),
      status: 'ready',
      indexed_doc_count: 100,
      source_doc_count: 100,
      error_message: null,
    })

    const status = await tantivyIndexStatus(bundleRoot)
    expect(status.checkpoint!.status).toBe('ready')
    expect(status.index_dir_valid).toBe(false)
    expect(status.ready_for_read).toBe(false)
  })

  it('surfaces the current pinned schema fingerprint verbatim', async () => {
    const status = await tantivyIndexStatus(bundleRoot)
    expect(status.current_schema_fingerprint).toBe(currentTantivySchemaFingerprint())
    expect(status.current_schema_fingerprint).toMatch(/^blake3:[0-9a-f]{64}$/)
  })

  it('throws when the on-disk checkpoint is malformed (read-side does not silently treat corrupt state as absent)', async () => {
    // Plant a malformed checkpoint by hand; `readIndexCheckpoint`
    // throws on invalid JSON, which propagates through the status
    // reader so corrupt state does not silently mask as "no
    // checkpoint".
    await mkdir(derivedPaths(bundleRoot).tantivy, { recursive: true })
    await writeFile(tantivyCheckpointPath(bundleRoot), '{ not really json')

    await expect(tantivyIndexStatus(bundleRoot)).rejects.toThrow(/malformed JSON|readIndexCheckpoint/i)
  })
})
