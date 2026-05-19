// Streaming counterpart tests for `iterateTranscriptFromBundle`.
//
// Mirrors `loadTranscriptFromBundle.test.ts` but exercises the
// generator return type:
//
//   - happy-path streaming round-trip with the production zstd default;
//   - newest-wins epoch selection (the bytes the generator walks are
//     the highest-epoch pack);
//   - ordinal range filter applied lazily during iteration;
//   - early-break: the consumer can stop pulling and not pay for
//     decompression of the remaining pages;
//   - missing-session ENOENT propagates from the eager pack load;
//   - sync sessionId validation (CQ-100 path) throws before the
//     generator object is returned;
//   - custom decompressor override accepted;
//   - CQ-098 intermediate-symlink rejection from the latest loader.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sessionBlobEpochDir, sessionBlobPackPath } from '../../src/derived-layout.js'
import { identityCompressor, identityDecompressor } from '../../src/session-blob/reader.js'
import { iterateTranscriptFromBundle } from '../../src/session-blob/transcript-from-bundle.js'
import { type BlobMessageInput, writeSessionBlobPack } from '../../src/session-blob/writer.js'
import { zstdSessionBlobCompressor } from '../../src/session-blob/zstd.js'

const SESSION_ID = 'ses_stream_demo'

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

async function writeZstdPack(bundleRoot: string, sessionId: string, epoch: number, count: number): Promise<void> {
  const messages = Array.from({ length: count }, (_, i) =>
    mkMessage(i, [inlineBlock(`blk_${i}_0`, 'text', `body ${i}`)]),
  )
  const result = writeSessionBlobPack({ session_id: sessionId, epoch, messages }, zstdSessionBlobCompressor)
  const dir = sessionBlobEpochDir(bundleRoot, epoch)
  await mkdir(dir, { recursive: true })
  await writeFile(sessionBlobPackPath(bundleRoot, sessionId, epoch), result.pack)
}

async function writeIdentityPack(bundleRoot: string, sessionId: string, epoch: number, count: number): Promise<void> {
  const messages = Array.from({ length: count }, (_, i) =>
    mkMessage(i, [inlineBlock(`blk_${i}_0`, 'text', `body ${i}`)]),
  )
  const result = writeSessionBlobPack({ session_id: sessionId, epoch, messages }, identityCompressor)
  const dir = sessionBlobEpochDir(bundleRoot, epoch)
  await mkdir(dir, { recursive: true })
  await writeFile(sessionBlobPackPath(bundleRoot, sessionId, epoch), result.pack)
}

describe('iterateTranscriptFromBundle', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-iter-bundle-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('streams all messages on a small zstd pack with the default decompressor', async () => {
    await writeZstdPack(bundleRoot, SESSION_ID, 2, 4)

    const { epoch, path, messages } = await iterateTranscriptFromBundle({ bundleRoot, sessionId: SESSION_ID })

    expect(epoch).toBe(2)
    expect(path).toBe(sessionBlobPackPath(bundleRoot, SESSION_ID, 2))

    const collected = []
    for (const msg of messages) collected.push(msg.ordinal)
    expect(collected).toEqual([0, 1, 2, 3])
  })

  it('streams the newest-epoch transcript when multiple epochs have packs', async () => {
    await writeZstdPack(bundleRoot, SESSION_ID, 1, 2)
    await writeZstdPack(bundleRoot, SESSION_ID, 5, 6)

    const { epoch, messages } = await iterateTranscriptFromBundle({ bundleRoot, sessionId: SESSION_ID })

    expect(epoch).toBe(5)
    const collected = []
    for (const msg of messages) collected.push(msg.ordinal)
    expect(collected).toHaveLength(6)
  })

  it('respects the ordinal range filter', async () => {
    await writeZstdPack(bundleRoot, SESSION_ID, 1, 10)

    const { messages } = await iterateTranscriptFromBundle({
      bundleRoot,
      sessionId: SESSION_ID,
      range: { startOrdinal: 4, endOrdinal: 7 },
    })

    const collected = []
    for (const msg of messages) collected.push(msg.ordinal)
    expect(collected).toEqual([4, 5, 6, 7])
  })

  it('supports lazy termination via early break (consumer stops pulling)', async () => {
    // 500 messages spans multiple pages even with zstd compression;
    // the generator must not eagerly decode every page when the
    // consumer breaks after a few yields.
    await writeZstdPack(bundleRoot, SESSION_ID, 3, 500)

    const { messages } = await iterateTranscriptFromBundle({ bundleRoot, sessionId: SESSION_ID })

    const collected = []
    for (const msg of messages) {
      collected.push(msg.ordinal)
      if (collected.length >= 5) break
    }
    expect(collected).toEqual([0, 1, 2, 3, 4])
    // The generator is now closed; calling `next()` post-break is a
    // protocol-level operation but does not crash.
  })

  it('throws with code=ENOENT eagerly when no epoch has a pack for this session', async () => {
    await expect(iterateTranscriptFromBundle({ bundleRoot, sessionId: SESSION_ID })).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects invalid sessionId eagerly (CQ-100 path: before generator is returned)', async () => {
    // Fresh bundle, invalid id — the validation must surface as a
    // resolver error, not as the synthetic fresh-bundle ENOENT.
    await expect(iterateTranscriptFromBundle({ bundleRoot, sessionId: 'ses/escape' })).rejects.toThrow(
      /characters outside/,
    )
    await expect(iterateTranscriptFromBundle({ bundleRoot, sessionId: '..' })).rejects.toThrow(/'\.\.' segments/)
    await expect(iterateTranscriptFromBundle({ bundleRoot, sessionId: '' })).rejects.toThrow(/non-empty string/)
  })

  it('accepts a custom decompressor override (identity pair)', async () => {
    await writeIdentityPack(bundleRoot, SESSION_ID, 1, 3)

    const { messages } = await iterateTranscriptFromBundle({
      bundleRoot,
      sessionId: SESSION_ID,
      decompress: identityDecompressor,
    })

    const collected = []
    for (const msg of messages) collected.push(msg.ordinal)
    expect(collected).toEqual([0, 1, 2])
  })

  it('propagates CQ-098 intermediate-symlink rejection from the latest loader', async () => {
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-iter-bundle-cq098-'))
    try {
      await mkdir(join(external, 'epoch-1'), { recursive: true })
      await mkdir(join(bundleRoot, 'derived'), { recursive: true })
      await symlink(external, join(bundleRoot, 'derived', 'session-blob'))

      await expect(iterateTranscriptFromBundle({ bundleRoot, sessionId: SESSION_ID })).rejects.toThrow(
        /CQ-098|intermediate/i,
      )
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('exposes the same metadata shape as loadTranscriptFromBundle (epoch / path / pack_digest)', async () => {
    await writeZstdPack(bundleRoot, SESSION_ID, 4, 1)

    const result = await iterateTranscriptFromBundle({ bundleRoot, sessionId: SESSION_ID })

    expect(result.epoch).toBe(4)
    expect(result.path).toBe(sessionBlobPackPath(bundleRoot, SESSION_ID, 4))
    expect(result.pack_digest).toMatch(/^blake3:[0-9a-f]{64}$/)
  })

  it('reads a specific historical epoch when `epoch` is provided (mirrors loadTranscriptFromBundle)', async () => {
    await writeZstdPack(bundleRoot, SESSION_ID, 1, 2)
    await writeZstdPack(bundleRoot, SESSION_ID, 4, 3)
    await writeZstdPack(bundleRoot, SESSION_ID, 9, 7)

    const result = await iterateTranscriptFromBundle({ bundleRoot, sessionId: SESSION_ID, epoch: 4 })

    expect(result.epoch).toBe(4)
    expect(result.path).toBe(sessionBlobPackPath(bundleRoot, SESSION_ID, 4))
    expect(result.pack_digest).toMatch(/^blake3:/)
    // Generator yields the 3 messages from epoch 4, not the 7 from epoch 9.
    const ordinals: number[] = []
    for (const message of result.messages) ordinals.push(message.ordinal)
    expect(ordinals).toEqual([0, 1, 2])
  })

  it('surfaces ENOENT when the requested epoch has no pack for the session', async () => {
    await writeZstdPack(bundleRoot, SESSION_ID, 1, 1)

    await expect(iterateTranscriptFromBundle({ bundleRoot, sessionId: SESSION_ID, epoch: 99 })).rejects.toThrow(
      /ENOENT|epoch-99/,
    )
  })
})
