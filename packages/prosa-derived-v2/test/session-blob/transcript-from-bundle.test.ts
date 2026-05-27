// End-to-end transcript loader tests.
//
// `loadTranscriptFromBundle({ bundleRoot, sessionId, range?, decompress? })`
// composes `loadLatestSessionBlobPack` with `iterateTranscript` /
// `loadTranscript`. Tests cover:
//
//   - happy-path round-trip with the production zstd default
//     decompressor (writer + reader both go through zstd-napi);
//   - newest-wins epoch selection (returns the messages from the
//     highest epoch with a pack);
//   - ordinal range filtering returns only the intersecting slice;
//   - missing-session ENOENT propagates with the right code;
//   - custom decompressor override accepted (identity pair for
//     symmetry with the byte-layout tests);
//   - CQ-098 intermediate-symlink propagation from the latest
//     loader;
//   - sync sessionId validation (forward-slash / empty).

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sessionBlobEpochDir, sessionBlobPackPath } from '../../src/derived-layout.js'
import { identityCompressor, identityDecompressor } from '../../src/session-blob/reader.js'
import { loadTranscriptFromBundle } from '../../src/session-blob/transcript-from-bundle.js'
import { type BlobMessageInput, writeSessionBlobPack } from '../../src/session-blob/writer.js'
import { zstdSessionBlobCompressor } from '../../src/session-blob/zstd.js'

const SESSION_ID = 'ses_e2e_demo'

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

describe('loadTranscriptFromBundle', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-e2e-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('round-trips a small zstd pack with the default decompressor', async () => {
    await writeZstdPack(bundleRoot, SESSION_ID, 3, 5)

    const result = await loadTranscriptFromBundle({ bundleRoot, sessionId: SESSION_ID })

    expect(result.epoch).toBe(3)
    expect(result.path).toBe(sessionBlobPackPath(bundleRoot, SESSION_ID, 3))
    expect(result.messages).toHaveLength(5)
    expect(result.messages.map((m) => m.ordinal)).toEqual([0, 1, 2, 3, 4])
    expect(result.messages[0]!.blocks[0]!.body).toEqual({
      kind: 'inline',
      text: 'body 0',
      byte_length: 6,
    })
  })

  it('returns the newest-epoch transcript when multiple epochs have packs', async () => {
    await writeZstdPack(bundleRoot, SESSION_ID, 1, 2)
    await writeZstdPack(bundleRoot, SESSION_ID, 4, 3)
    await writeZstdPack(bundleRoot, SESSION_ID, 9, 7)

    const result = await loadTranscriptFromBundle({ bundleRoot, sessionId: SESSION_ID })

    expect(result.epoch).toBe(9)
    expect(result.messages).toHaveLength(7)
  })

  it('applies the optional ordinal range filter', async () => {
    await writeZstdPack(bundleRoot, SESSION_ID, 2, 10)

    const result = await loadTranscriptFromBundle({
      bundleRoot,
      sessionId: SESSION_ID,
      range: { startOrdinal: 3, endOrdinal: 6 },
    })

    expect(result.messages.map((m) => m.ordinal)).toEqual([3, 4, 5, 6])
  })

  it('throws with code=ENOENT when no epoch contains a pack for this session', async () => {
    await expect(loadTranscriptFromBundle({ bundleRoot, sessionId: SESSION_ID })).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('accepts a custom decompressor override (identity pair)', async () => {
    await writeIdentityPack(bundleRoot, SESSION_ID, 1, 4)

    const result = await loadTranscriptFromBundle({
      bundleRoot,
      sessionId: SESSION_ID,
      decompress: identityDecompressor,
    })

    expect(result.epoch).toBe(1)
    expect(result.messages.map((m) => m.ordinal)).toEqual([0, 1, 2, 3])
  })

  it('rejects sessionId synchronously when the resolver would reject it', async () => {
    await writeZstdPack(bundleRoot, SESSION_ID, 1, 1)
    await expect(loadTranscriptFromBundle({ bundleRoot, sessionId: 'ses/escape' })).rejects.toThrow(
      /characters outside/,
    )
    await expect(loadTranscriptFromBundle({ bundleRoot, sessionId: '..' })).rejects.toThrow(/'\.\.' segments/)
    await expect(loadTranscriptFromBundle({ bundleRoot, sessionId: '' })).rejects.toThrow(/non-empty string/)
  })

  it('propagates CQ-098 intermediate-symlink rejection from the latest loader', async () => {
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-e2e-cq098-'))
    try {
      await mkdir(join(external, 'epoch-3'), { recursive: true })
      await mkdir(join(bundleRoot, 'derived'), { recursive: true })
      await symlink(external, join(bundleRoot, 'derived', 'session-blob'))

      await expect(loadTranscriptFromBundle({ bundleRoot, sessionId: SESSION_ID })).rejects.toThrow(
        /CQ-098|intermediate/i,
      )
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('exposes the recomputed pack_digest in the result', async () => {
    await writeZstdPack(bundleRoot, SESSION_ID, 2, 1)

    const result = await loadTranscriptFromBundle({ bundleRoot, sessionId: SESSION_ID })

    // Same blake3 prefix the writer/reader use throughout.
    expect(result.pack_digest).toMatch(/^blake3:[0-9a-f]{64}$/)
  })

  it('reads a specific historical epoch when `epoch` is provided', async () => {
    await writeZstdPack(bundleRoot, SESSION_ID, 1, 2)
    await writeZstdPack(bundleRoot, SESSION_ID, 4, 3)
    await writeZstdPack(bundleRoot, SESSION_ID, 9, 7)

    const result = await loadTranscriptFromBundle({ bundleRoot, sessionId: SESSION_ID, epoch: 4 })

    expect(result.epoch).toBe(4)
    expect(result.messages).toHaveLength(3)
    expect(result.path).toMatch(/epoch-4/)
    expect(result.pack_digest).toMatch(/^blake3:/)
  })

  it('surfaces ENOENT when the requested epoch has no pack for the session', async () => {
    await writeZstdPack(bundleRoot, SESSION_ID, 1, 2)

    await expect(loadTranscriptFromBundle({ bundleRoot, sessionId: SESSION_ID, epoch: 42 })).rejects.toThrow(
      /ENOENT|epoch-42/,
    )
  })
})
