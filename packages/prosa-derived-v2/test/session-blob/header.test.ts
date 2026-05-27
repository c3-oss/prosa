// SessionBlobPackV2 header-only reader tests.
//
// `readSessionBlobHeader({ bundleRoot, sessionId, epoch? })` covers
// two paths:
//
//   - `epoch` supplied → reads the specific epoch's header via
//     `loadSessionBlobPack`;
//   - `epoch` omitted → finds the newest epoch's header via
//     `loadLatestSessionBlobPack`.
//
// Both paths return `{ epoch, path, pack_digest, header }` with the
// pack digest re-verified from the bytes. No page is decompressed,
// so the returned header counts (page_count, ordinal ranges, turn /
// tool-call counts) come directly from the canonical-JSON header.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sessionBlobEpochDir, sessionBlobPackPath } from '../../src/derived-layout.js'
import { readSessionBlobHeader } from '../../src/session-blob/header.js'
import { identityCompressor } from '../../src/session-blob/reader.js'
import { type BlobMessageInput, writeSessionBlobPack } from '../../src/session-blob/writer.js'

const SESSION_ID = 'ses_header_demo'

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
  return result
}

describe('readSessionBlobHeader', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-header-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns the header for an explicit epoch with pack_digest re-verified', async () => {
    const expected = await writePack(bundleRoot, SESSION_ID, 3, 5)

    const result = await readSessionBlobHeader({ bundleRoot, sessionId: SESSION_ID, epoch: 3 })

    expect(result.epoch).toBe(3)
    expect(result.path).toBe(sessionBlobPackPath(bundleRoot, SESSION_ID, 3))
    expect(result.pack_digest).toBe(expected.pack_digest)
    expect(result.header.epoch).toBe(3)
    expect(result.header.compression).toBe('zstd')
    expect(result.header.page_count).toBe(expected.header.page_count)
    expect(result.header.pages.length).toBe(expected.header.page_count)
  })

  it('returns the newest-epoch header when epoch is omitted', async () => {
    await writePack(bundleRoot, SESSION_ID, 1, 2)
    await writePack(bundleRoot, SESSION_ID, 5, 8)

    const result = await readSessionBlobHeader({ bundleRoot, sessionId: SESSION_ID })

    expect(result.epoch).toBe(5)
    expect(result.header.epoch).toBe(5)
  })

  it('exposes per-page ordinal range + counts without decompressing pages', async () => {
    // 50 messages, single block each — paginates into a small number
    // of pages; we just verify the per-page ranges add up.
    const expected = await writePack(bundleRoot, SESSION_ID, 1, 50)

    const result = await readSessionBlobHeader({ bundleRoot, sessionId: SESSION_ID, epoch: 1 })

    const totalMessages = result.header.pages.reduce((acc, p) => acc + p.message_count, 0)
    expect(totalMessages).toBe(50)
    // First page starts at ordinal 0.
    expect(result.header.pages[0]!.message_ordinal_start).toBe(0)
    // Last page ends at ordinal 49.
    expect(result.header.pages.at(-1)!.message_ordinal_end).toBe(49)
    // Per-page shape matches the writer's emission.
    expect(result.header.page_count).toBe(expected.header.page_count)
  })

  it('throws with code=ENOENT when the explicit epoch has no pack for this session', async () => {
    await mkdir(sessionBlobEpochDir(bundleRoot, 1), { recursive: true })
    await expect(readSessionBlobHeader({ bundleRoot, sessionId: SESSION_ID, epoch: 1 })).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('throws with code=ENOENT when no epoch has a pack for this session (epoch omitted)', async () => {
    await expect(readSessionBlobHeader({ bundleRoot, sessionId: SESSION_ID })).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects invalid sessionId synchronously (CQ-100 path, both with and without epoch)', async () => {
    // Without epoch — exercises the latest-loader's CQ-100 validate-
    // before-listing path.
    await expect(readSessionBlobHeader({ bundleRoot, sessionId: 'ses/escape' })).rejects.toThrow(/characters outside/)
    await expect(readSessionBlobHeader({ bundleRoot, sessionId: '..' })).rejects.toThrow(/'\.\.' segments/)
    // With epoch — exercises the specific loader's `sessionBlobPackPath`
    // validation.
    await expect(readSessionBlobHeader({ bundleRoot, sessionId: 'ses/escape', epoch: 0 })).rejects.toThrow(
      /characters outside/,
    )
  })

  it('propagates CQ-094 final-component symlink rejection (explicit epoch)', async () => {
    const expected = await writePack(bundleRoot, SESSION_ID, 2, 1)
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-header-cq094-'))
    try {
      // Plant an external pack and replace the real one with a symlink
      // to it. The reader must refuse to follow.
      const externalPath = join(external, 'external.pack')
      await writeFile(externalPath, expected.pack)
      // Remove the real pack and replace with a symlink.
      await rm(sessionBlobPackPath(bundleRoot, SESSION_ID, 2))
      await symlink(externalPath, sessionBlobPackPath(bundleRoot, SESSION_ID, 2))

      await expect(readSessionBlobHeader({ bundleRoot, sessionId: SESSION_ID, epoch: 2 })).rejects.toThrow(
        /symlink|CQ-094/i,
      )
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('propagates CQ-098 intermediate-symlink rejection (epoch omitted, via latest loader)', async () => {
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-header-cq098-'))
    try {
      await mkdir(join(external, 'epoch-1'), { recursive: true })
      await mkdir(join(bundleRoot, 'derived'), { recursive: true })
      await symlink(external, join(bundleRoot, 'derived', 'session-blob'))

      await expect(readSessionBlobHeader({ bundleRoot, sessionId: SESSION_ID })).rejects.toThrow(/CQ-098|intermediate/i)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('detects tampered pack bytes via pack_digest re-verification (explicit epoch)', async () => {
    const expected = await writePack(bundleRoot, SESSION_ID, 4, 2)

    // Tamper deep in the payload.
    const tampered = new Uint8Array(expected.pack)
    tampered[tampered.length - 8] = (tampered[tampered.length - 8]! + 1) & 0xff
    await writeFile(sessionBlobPackPath(bundleRoot, SESSION_ID, 4), tampered)

    await expect(readSessionBlobHeader({ bundleRoot, sessionId: SESSION_ID, epoch: 4 })).rejects.toThrow(
      /verifyPackDigest|mismatch|hash|stored_length/i,
    )
  })

  it('returns the same pack_digest the writer emitted', async () => {
    const expected = await writePack(bundleRoot, SESSION_ID, 9, 3)
    const result = await readSessionBlobHeader({ bundleRoot, sessionId: SESSION_ID, epoch: 9 })
    expect(result.pack_digest).toBe(expected.pack_digest)
    expect(result.header.pack_digest).toBe(expected.pack_digest)
  })
})
