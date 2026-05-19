// SessionBlobPackV2 "latest epoch" loader tests.
//
// `loadLatestSessionBlobPack({ bundleRoot, sessionId })` walks the
// epochs reported by `listSessionBlobEpochs` newest-first and returns
// the first epoch's pack that exists. The tests cover:
//
//   - happy-path single-epoch return (with epoch field correctly set);
//   - multi-epoch newest-wins selection;
//   - holes in the epoch sequence (skip-when-missing);
//   - missing-in-newest-but-present-in-older fallback;
//   - session has no pack anywhere (ENOENT throw with `code: 'ENOENT'`);
//   - fresh bundle (no epochs at all) ENOENT throw;
//   - sync sessionId validation (forward-slash → reject);
//   - CQ-098 intermediate-symlink propagation (`derived/session-blob`
//     symlinked → throw before any per-epoch attempt);
//   - non-ENOENT failures (e.g. CQ-094 final-component symlink at
//     a specific epoch's pack file) propagate immediately rather than
//     being masked by the fallback walk.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sessionBlobEpochDir, sessionBlobPackPath } from '../../src/derived-layout.js'
import { loadLatestSessionBlobPack } from '../../src/session-blob/latest.js'
import { identityCompressor } from '../../src/session-blob/reader.js'
import { type BlobMessageInput, writeSessionBlobPack } from '../../src/session-blob/writer.js'

const SESSION_ID = 'ses_latest_demo'

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

async function writePackToEpoch(bundleRoot: string, sessionId: string, epoch: number, text: string) {
  const messages = [mkMessage(0, [inlineBlock('blk_0_0', 'text', text)])]
  const result = writeSessionBlobPack({ session_id: sessionId, epoch, messages }, identityCompressor)
  const dir = sessionBlobEpochDir(bundleRoot, epoch)
  await mkdir(dir, { recursive: true })
  const path = sessionBlobPackPath(bundleRoot, sessionId, epoch)
  await writeFile(path, result.pack)
  return { path, expected: result }
}

describe('loadLatestSessionBlobPack', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-latest-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns the only epoch when exactly one pack exists', async () => {
    await writePackToEpoch(bundleRoot, SESSION_ID, 3, 'only-epoch')

    const loaded = await loadLatestSessionBlobPack({ bundleRoot, sessionId: SESSION_ID })

    expect(loaded.epoch).toBe(3)
    expect(loaded.header.epoch).toBe(3)
    expect(loaded.path).toBe(sessionBlobPackPath(bundleRoot, SESSION_ID, 3))
  })

  it('returns the highest epoch when multiple packs exist (newest wins)', async () => {
    await writePackToEpoch(bundleRoot, SESSION_ID, 1, 'oldest')
    await writePackToEpoch(bundleRoot, SESSION_ID, 3, 'middle')
    await writePackToEpoch(bundleRoot, SESSION_ID, 7, 'latest')

    const loaded = await loadLatestSessionBlobPack({ bundleRoot, sessionId: SESSION_ID })

    expect(loaded.epoch).toBe(7)
    expect(loaded.header.epoch).toBe(7)
  })

  it('skips an empty newer epoch and falls back to a populated older epoch', async () => {
    await writePackToEpoch(bundleRoot, SESSION_ID, 1, 'old')
    await writePackToEpoch(bundleRoot, SESSION_ID, 3, 'middle')
    // Create epoch-7 but do NOT write this session's pack to it
    // (some other session was active in epoch 7).
    await mkdir(sessionBlobEpochDir(bundleRoot, 7), { recursive: true })
    await writeFile(sessionBlobPackPath(bundleRoot, 'ses_other', 7), 'fake')

    const loaded = await loadLatestSessionBlobPack({ bundleRoot, sessionId: SESSION_ID })

    expect(loaded.epoch).toBe(3)
  })

  it('handles holes in the epoch sequence (epoch 0 / epoch 5, missing epochs in between)', async () => {
    await writePackToEpoch(bundleRoot, SESSION_ID, 0, 'genesis')
    await writePackToEpoch(bundleRoot, SESSION_ID, 5, 'jumped')

    const loaded = await loadLatestSessionBlobPack({ bundleRoot, sessionId: SESSION_ID })

    expect(loaded.epoch).toBe(5)
  })

  it('throws with code=ENOENT when no epoch contains a pack for this session', async () => {
    // Two epochs exist but neither has this session's pack.
    await mkdir(sessionBlobEpochDir(bundleRoot, 2), { recursive: true })
    await mkdir(sessionBlobEpochDir(bundleRoot, 5), { recursive: true })
    await writeFile(sessionBlobPackPath(bundleRoot, 'ses_other_a', 2), 'fake')
    await writeFile(sessionBlobPackPath(bundleRoot, 'ses_other_b', 5), 'fake')

    await expect(loadLatestSessionBlobPack({ bundleRoot, sessionId: SESSION_ID })).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('throws with code=ENOENT on a fresh bundle (no epochs at all)', async () => {
    await expect(loadLatestSessionBlobPack({ bundleRoot, sessionId: SESSION_ID })).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects sessionId synchronously when the resolver would reject it', async () => {
    await writePackToEpoch(bundleRoot, SESSION_ID, 1, 'unused')
    await expect(loadLatestSessionBlobPack({ bundleRoot, sessionId: 'ses/escape' })).rejects.toThrow(
      /characters outside/,
    )
    await expect(loadLatestSessionBlobPack({ bundleRoot, sessionId: '..' })).rejects.toThrow(/'\.\.' segments/)
    await expect(loadLatestSessionBlobPack({ bundleRoot, sessionId: '' })).rejects.toThrow(/non-empty string/)
  })

  it('propagates CQ-098 intermediate-symlink rejection from the epoch listing', async () => {
    // `derived/session-blob` symlinked → `listSessionBlobEpochs`
    // throws synchronously; the latest loader bubbles the error up
    // unchanged before any per-epoch I/O.
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-latest-cq098-'))
    try {
      await mkdir(join(external, 'epoch-3'), { recursive: true })
      await mkdir(join(bundleRoot, 'derived'), { recursive: true })
      await symlink(external, join(bundleRoot, 'derived', 'session-blob'))

      await expect(loadLatestSessionBlobPack({ bundleRoot, sessionId: SESSION_ID })).rejects.toThrow(
        /CQ-098|intermediate/i,
      )
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('does NOT mask non-ENOENT per-epoch failures with the fallback walk (CQ-094 surfaces)', async () => {
    // Older epoch has a real pack. Newer epoch has a symlinked pack
    // file — the loader must surface the CQ-094 refusal rather than
    // silently falling back to the older epoch.
    await writePackToEpoch(bundleRoot, SESSION_ID, 1, 'real')
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-latest-cq094-'))
    try {
      const realLater = writeSessionBlobPack(
        { session_id: SESSION_ID, epoch: 4, messages: [mkMessage(0, [inlineBlock('blk_0_0', 'text', 'plant')])] },
        identityCompressor,
      )
      await writeFile(join(external, 'planted.pack'), realLater.pack)
      const dir = sessionBlobEpochDir(bundleRoot, 4)
      await mkdir(dir, { recursive: true })
      await symlink(join(external, 'planted.pack'), sessionBlobPackPath(bundleRoot, SESSION_ID, 4))

      await expect(loadLatestSessionBlobPack({ bundleRoot, sessionId: SESSION_ID })).rejects.toThrow(/symlink|CQ-094/i)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('returns ready-to-iterate pageBytes alongside the epoch field', async () => {
    await writePackToEpoch(bundleRoot, SESSION_ID, 9, 'compose')

    const loaded = await loadLatestSessionBlobPack({ bundleRoot, sessionId: SESSION_ID })

    expect(loaded.epoch).toBe(9)
    expect(loaded.pageBytes.length).toBe(loaded.header.page_count)
    for (let i = 0; i < loaded.header.page_count; i++) {
      expect(loaded.pageBytes[i]!.length).toBe(loaded.header.pages[i]!.stored_length)
    }
  })
})
