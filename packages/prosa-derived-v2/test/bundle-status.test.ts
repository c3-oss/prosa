// Bundle-level derived-layer status aggregator tests.
//
// `bundleDerivedStatus(bundleRoot)` composes `tantivyIndexStatus` +
// `listSessionBlobSummaries` + `listSessionBlobEpochs` into one
// snapshot for top-level dashboards. The tests cover empty, mixed,
// and fully-populated bundles, plus containment propagation from
// the SessionBlob aggregation.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bundleDerivedStatus } from '../src/bundle-status.js'
import { sessionBlobEpochDir, sessionBlobPackPath } from '../src/derived-layout.js'
import { identityCompressor } from '../src/session-blob/reader.js'
import { type BlobMessageInput, writeSessionBlobPack } from '../src/session-blob/writer.js'
import { writeIndexCheckpoint } from '../src/tantivy/checkpoint-store.js'
import { tantivyIndexDir, tantivyMetaPath } from '../src/tantivy/index-dir.js'
import { currentTantivySchemaFingerprint } from '../src/tantivy/schema.js'

function inlineBlock(blockId: string, blockType: string, text: string) {
  return {
    block_id: blockId,
    block_type: blockType,
    body: { kind: 'inline' as const, text, byte_length: new TextEncoder().encode(text).length },
  }
}

function mkMessage(i: number, blocks: BlobMessageInput['blocks']): BlobMessageInput {
  return {
    message_id: `msg_${i.toString().padStart(6, '0')}`,
    ordinal: i,
    role: i % 2 === 0 ? 'user' : 'assistant',
    timestamp: `2026-05-19T00:00:${(i % 60).toString().padStart(2, '0')}.000Z`,
    turn_id: `tur_${Math.floor(i / 2)}`,
    blocks,
  }
}

async function writePack(bundleRoot: string, sessionId: string, epoch: number, count: number) {
  const messages = Array.from({ length: count }, (_, i) =>
    mkMessage(i, [inlineBlock(`blk_${i}_0`, 'text', `body ${i}`)]),
  )
  const result = writeSessionBlobPack({ session_id: sessionId, epoch, messages }, identityCompressor)
  const dir = sessionBlobEpochDir(bundleRoot, epoch)
  await mkdir(dir, { recursive: true })
  await writeFile(sessionBlobPackPath(bundleRoot, sessionId, epoch), result.pack)
}

async function plantValidIndexDir(bundleRoot: string) {
  await mkdir(tantivyIndexDir(bundleRoot), { recursive: true })
  await writeFile(tantivyMetaPath(bundleRoot), JSON.stringify({ segments: [] }))
}

describe('bundleDerivedStatus', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-bundle-status-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns an empty snapshot on a fresh bundle', async () => {
    const status = await bundleDerivedStatus(bundleRoot)

    expect(status.tantivy.checkpoint_present).toBe(false)
    expect(status.tantivy.index_dir_valid).toBe(false)
    expect(status.tantivy.ready_for_read).toBe(false)
    expect(status.session_summaries).toEqual([])
    expect(status.session_count).toBe(0)
    expect(status.session_blob_epochs).toEqual([])
  })

  it('returns SessionBlob inventory when packs exist (no Tantivy index)', async () => {
    await writePack(bundleRoot, 'ses_alpha', 1, 3)
    await writePack(bundleRoot, 'ses_bravo', 2, 5)

    const status = await bundleDerivedStatus(bundleRoot)

    expect(status.session_summaries.map((s) => s.session_id)).toEqual(['ses_alpha', 'ses_bravo'])
    expect(status.session_count).toBe(2)
    expect(status.session_blob_epochs).toEqual([1, 2])
    // Tantivy side still empty.
    expect(status.tantivy.checkpoint_present).toBe(false)
    expect(status.tantivy.ready_for_read).toBe(false)
  })

  it('returns Tantivy status when an index exists (no SessionBlob packs)', async () => {
    await plantValidIndexDir(bundleRoot)
    await writeIndexCheckpoint(bundleRoot, {
      last_indexed_rowid: 100,
      schema_fingerprint: currentTantivySchemaFingerprint(),
      status: 'ready',
      indexed_doc_count: 100,
      source_doc_count: 100,
      error_message: null,
    })

    const status = await bundleDerivedStatus(bundleRoot)

    expect(status.tantivy.checkpoint_present).toBe(true)
    expect(status.tantivy.index_dir_valid).toBe(true)
    expect(status.tantivy.ready_for_read).toBe(true)
    // SessionBlob side still empty.
    expect(status.session_summaries).toEqual([])
    expect(status.session_count).toBe(0)
  })

  it('returns combined snapshot when both subsystems are populated', async () => {
    await plantValidIndexDir(bundleRoot)
    await writeIndexCheckpoint(bundleRoot, {
      last_indexed_rowid: 50,
      schema_fingerprint: currentTantivySchemaFingerprint(),
      status: 'ready',
      indexed_doc_count: 50,
      source_doc_count: 50,
      error_message: null,
    })
    await writePack(bundleRoot, 'ses_alpha', 1, 2)
    await writePack(bundleRoot, 'ses_bravo', 1, 3)
    await writePack(bundleRoot, 'ses_alpha', 4, 6) // newer epoch for alpha

    const status = await bundleDerivedStatus(bundleRoot)

    expect(status.tantivy.ready_for_read).toBe(true)
    expect(status.session_count).toBe(2)
    expect(status.session_summaries.map((s) => s.latest_epoch)).toEqual([4, 1])
    expect(status.session_blob_epochs).toEqual([1, 4])
  })

  it('session_count equals session_summaries.length (no drift)', async () => {
    await writePack(bundleRoot, 'ses_a', 1, 1)
    await writePack(bundleRoot, 'ses_b', 1, 1)
    await writePack(bundleRoot, 'ses_c', 1, 1)
    const status = await bundleDerivedStatus(bundleRoot)
    expect(status.session_count).toBe(status.session_summaries.length)
    expect(status.session_count).toBe(3)
  })

  it('propagates CQ-098 intermediate-symlink rejection from the SessionBlob aggregation', async () => {
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-bundle-status-cq098-'))
    try {
      await mkdir(join(external, 'epoch-1'), { recursive: true })
      await mkdir(join(bundleRoot, 'derived'), { recursive: true })
      await symlink(external, join(bundleRoot, 'derived', 'session-blob'))

      await expect(bundleDerivedStatus(bundleRoot)).rejects.toThrow(/CQ-098|intermediate/i)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('accepts a symlinked bundle-root alias when both subsystems are real', async () => {
    await plantValidIndexDir(bundleRoot)
    await writePack(bundleRoot, 'ses_alpha', 2, 4)

    const aliasParent = await mkdtemp(join(tmpdir(), 'prosa-derived-bundle-status-alias-'))
    try {
      const aliasRoot = join(aliasParent, 'bundle-alias')
      await symlink(bundleRoot, aliasRoot)

      const status = await bundleDerivedStatus(aliasRoot)

      expect(status.tantivy.index_dir_valid).toBe(true)
      expect(status.session_count).toBe(1)
      expect(status.session_summaries[0]!.session_id).toBe('ses_alpha')
    } finally {
      await rm(aliasParent, { recursive: true, force: true })
    }
  })

  it('exposes the current Tantivy schema fingerprint in the result', async () => {
    const status = await bundleDerivedStatus(bundleRoot)
    expect(status.tantivy.current_schema_fingerprint).toBe(currentTantivySchemaFingerprint())
  })
})
