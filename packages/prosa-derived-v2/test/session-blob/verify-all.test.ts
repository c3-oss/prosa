// Tests for `verifyAllSessionBlobPacks`.
//
// The verifier composes the listing + loader, so most cases echo the
// shape covered by those tests. What this file uniquely validates is
// that:
//   - successful packs land in `verified[]` (not `failed[]`),
//   - corrupted packs land in `failed[]` instead of throwing,
//   - the walk does not stop at the first failure,
//   - containment errors (CQ-098) propagate from the listing rather
//     than being captured as a per-pack failure.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sessionBlobEpochDir, sessionBlobPackPath } from '../../src/derived-layout.js'
import { identityCompressor } from '../../src/session-blob/reader.js'
import { verifyAllSessionBlobPacks } from '../../src/session-blob/verify-all.js'
import { type BlobMessageInput, writeSessionBlobPack } from '../../src/session-blob/writer.js'

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
    timestamp: '2026-05-19T00:00:00.000Z',
    turn_id: `tur_${Math.floor(i / 2)}`,
    blocks,
  }
}

async function writeIdentityPack(bundleRoot: string, sessionId: string, epoch: number, count: number): Promise<void> {
  const messages = Array.from({ length: count }, (_, i) =>
    mkMessage(i, [inlineBlock(`blk_${i}_0`, 'text', `body ${i}`)]),
  )
  const result = writeSessionBlobPack({ session_id: sessionId, epoch, messages }, identityCompressor)
  await mkdir(sessionBlobEpochDir(bundleRoot, epoch), { recursive: true })
  await writeFile(sessionBlobPackPath(bundleRoot, sessionId, epoch), result.pack)
}

describe('verifyAllSessionBlobPacks', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-verify-all-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns empty arrays for a fresh bundle (no SessionBlob epochs)', async () => {
    const result = await verifyAllSessionBlobPacks(bundleRoot)
    expect(result.verified).toEqual([])
    expect(result.failed).toEqual([])
  })

  it('lands every successfully-loaded pack in `verified` with its digest and path', async () => {
    await writeIdentityPack(bundleRoot, 'ses_alpha', 1, 2)
    await writeIdentityPack(bundleRoot, 'ses_bravo', 1, 1)
    await writeIdentityPack(bundleRoot, 'ses_alpha', 2, 3)

    const result = await verifyAllSessionBlobPacks(bundleRoot)

    expect(result.failed).toEqual([])
    expect(result.verified).toHaveLength(3)
    // Listing order: (epoch ascending, session_id ascending within epoch).
    expect(result.verified.map((r) => `${r.epoch}/${r.session_id}`)).toEqual([
      '1/ses_alpha',
      '1/ses_bravo',
      '2/ses_alpha',
    ])
    for (const row of result.verified) {
      expect(row.pack_digest).toMatch(/^blake3:[0-9a-f]{64}$/)
      expect(row.path).toMatch(new RegExp(`epoch-${row.epoch}`))
    }
  })

  it('captures a tampered pack as a `failed` row without aborting the walk', async () => {
    // Plant 3 valid packs, then corrupt the middle one.
    await writeIdentityPack(bundleRoot, 'ses_alpha', 1, 1)
    await writeIdentityPack(bundleRoot, 'ses_bravo', 1, 1)
    await writeIdentityPack(bundleRoot, 'ses_charlie', 1, 1)
    // Flip a few content bytes in `ses_bravo` so `verifyPackDigest`
    // re-computes a mismatching digest.
    const bravoPath = sessionBlobPackPath(bundleRoot, 'ses_bravo', 1)
    const { readFile, writeFile: writeFileBytes } = await import('node:fs/promises')
    const bytes = new Uint8Array(await readFile(bravoPath))
    // Flip a byte deep enough that the header CRC check is past.
    bytes[bytes.length - 16] = (bytes[bytes.length - 16] ?? 0) ^ 0xff
    await writeFileBytes(bravoPath, bytes)

    const result = await verifyAllSessionBlobPacks(bundleRoot)

    expect(result.verified.map((r) => r.session_id)).toEqual(['ses_alpha', 'ses_charlie'])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.session_id).toBe('ses_bravo')
    expect(result.failed[0]?.epoch).toBe(1)
    expect(typeof result.failed[0]?.error).toBe('string')
    expect(result.failed[0]?.error.length).toBeGreaterThan(0)
  })

  it('propagates CQ-098 intermediate-symlink rejection from the listing rather than capturing it', async () => {
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-verify-all-cq098-'))
    try {
      await mkdir(join(external, 'epoch-1'), { recursive: true })
      await mkdir(join(bundleRoot, 'derived'), { recursive: true })
      await symlink(external, join(bundleRoot, 'derived', 'session-blob'))

      await expect(verifyAllSessionBlobPacks(bundleRoot)).rejects.toThrow(/CQ-098|intermediate/i)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })
})
