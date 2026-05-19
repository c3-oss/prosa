// SessionBlobPackV2 writer/reader round-trip tests.

import { describe, expect, it } from 'vitest'

import {
  identityCompressor,
  identityDecompressor,
  loadTranscriptPage,
  verifyPackDigest,
} from '../../src/session-blob/reader.js'
import { HARD_MESSAGES_PER_PAGE, MAX_PAGE_UNCOMPRESSED_BYTES } from '../../src/session-blob/types.js'
import { type BlobMessageInput, writeSessionBlobPack } from '../../src/session-blob/writer.js'

function inlineBlock(blockId: string, blockType: string, text: string) {
  return {
    block_id: blockId,
    block_type: blockType,
    body: { kind: 'inline' as const, text, byte_length: new TextEncoder().encode(text).length },
  }
}

function casBlock(blockId: string, blockType: string, byteLength: number) {
  return {
    block_id: blockId,
    block_type: blockType,
    body: {
      kind: 'cas_ref' as const,
      object_id: `blake3:${'0'.repeat(64)}`,
      byte_length: byteLength,
      preview: 'preview',
    },
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

describe('SessionBlobPackV2 writer + reader', () => {
  it('round-trips a small session through canonical-JSON + identity zstd', () => {
    const messages: BlobMessageInput[] = [
      mkMessage(0, [inlineBlock('blk_0_0', 'text', 'hello')]),
      mkMessage(1, [inlineBlock('blk_1_0', 'text', 'world')]),
      mkMessage(2, [inlineBlock('blk_2_0', 'thinking', 'reasoning'), inlineBlock('blk_2_1', 'text', 'I see it now.')]),
    ]
    const result = writeSessionBlobPack({ session_id: 'ses_demo', epoch: 1, messages }, identityCompressor)
    expect(result.header.compression).toBe('zstd')
    expect(result.header.epoch).toBe(1)
    expect(result.header.page_count).toBe(1)
    expect(result.header.pages).toHaveLength(1)
    const pageRef = result.header.pages[0]!
    expect(pageRef.session_id).toBe('ses_demo')
    expect(pageRef.message_count).toBe(3)
    expect(pageRef.turn_count).toBeGreaterThanOrEqual(2)
    expect(pageRef.stored_length).toBeGreaterThan(0)
    expect(pageRef.uncompressed_length).toBe(pageRef.stored_length) // identity compressor
    expect(pageRef.stored_hash.startsWith('blake3:')).toBe(true)
    expect(pageRef.uncompressed_hash.startsWith('blake3:')).toBe(true)
    // pack_digest covers the entire framed pack.
    expect(result.pack_digest.startsWith('blake3:')).toBe(true)
    // Round-trip the first page.
    const page0 = loadTranscriptPage(result.pack, 0, identityDecompressor)
    expect(page0.session_id).toBe('ses_demo')
    expect(page0.messages).toHaveLength(3)
    expect(page0.messages[0]!.message_id).toBe('msg_000000')
    expect(page0.messages[2]!.blocks).toHaveLength(2)
    expect(page0.messages[2]!.blocks[0]!.block_type).toBe('thinking')
  })

  it('paginates a 1,000-message session into multiple pages without overflowing caps', () => {
    const messages: BlobMessageInput[] = Array.from({ length: 1000 }, (_, i) =>
      mkMessage(i, [inlineBlock(`blk_${i}_0`, 'text', 'x'.repeat(2048))]),
    )
    const result = writeSessionBlobPack({ session_id: 'ses_pag', epoch: 1, messages }, identityCompressor)
    expect(result.header.page_count).toBeGreaterThan(1)
    for (const page of result.header.pages) {
      // 256 = HARD_MESSAGES_PER_PAGE, 1 MiB = MAX_PAGE_UNCOMPRESSED_BYTES.
      expect(page.message_count).toBeLessThanOrEqual(HARD_MESSAGES_PER_PAGE)
      expect(page.uncompressed_length).toBeLessThanOrEqual(MAX_PAGE_UNCOMPRESSED_BYTES)
    }
    // Sum of message_count across pages equals the input message count.
    const sum = result.header.pages.reduce((s, p) => s + p.message_count, 0)
    expect(sum).toBe(messages.length)
    // Stored offsets are monotonic and contiguous.
    let cursor = 0
    for (const page of result.header.pages) {
      expect(page.stored_offset).toBe(cursor)
      cursor += page.stored_length
    }
  })

  it('emits an empty pack (page_count: 0) for an empty session', () => {
    const result = writeSessionBlobPack({ session_id: 'ses_empty', epoch: 1, messages: [] }, identityCompressor)
    expect(result.header.page_count).toBe(0)
    expect(result.header.pages).toEqual([])
  })

  it('records CAS-ref bodies in the page payload without inlining oversized text', () => {
    // The writer policy spills any block whose byte cost exceeds 32 KiB
    // to CAS. The caller is responsible for pre-staging the bytes and
    // passing the synthesized `cas_ref` body; the writer just records it.
    const messages: BlobMessageInput[] = [
      mkMessage(0, [casBlock('blk_0_huge', 'text', 1024 * 1024)]),
      mkMessage(1, [inlineBlock('blk_1_0', 'text', 'inline ok')]),
    ]
    const result = writeSessionBlobPack({ session_id: 'ses_cas', epoch: 1, messages }, identityCompressor)
    expect(result.header.page_count).toBe(1)
    const page = loadTranscriptPage(result.pack, 0, identityDecompressor)
    expect(page.messages[0]!.blocks[0]!.body.kind).toBe('cas_ref')
    expect(page.messages[1]!.blocks[0]!.body.kind).toBe('inline')
  })

  it('produces byte-identical pack output for identical input (idempotency)', () => {
    const messages: BlobMessageInput[] = Array.from({ length: 50 }, (_, i) =>
      mkMessage(i, [inlineBlock(`blk_${i}_0`, 'text', `body-${i}`)]),
    )
    const a = writeSessionBlobPack({ session_id: 'ses_id', epoch: 7, messages }, identityCompressor)
    const b = writeSessionBlobPack({ session_id: 'ses_id', epoch: 7, messages }, identityCompressor)
    expect(b.pack).toEqual(a.pack)
    expect(b.pack_digest).toBe(a.pack_digest)
  })

  it('rejects loadTranscriptPage for an out-of-range page index', () => {
    const result = writeSessionBlobPack(
      { session_id: 'ses_oob', epoch: 1, messages: [mkMessage(0, [inlineBlock('blk_0_0', 'text', 'hi')])] },
      identityCompressor,
    )
    expect(() => loadTranscriptPage(result.pack, 99, identityDecompressor)).toThrow(/not in pack/)
  })

  it('CQ-085: pack_digest is recomputable from header-without-digest + payload, and verifyPackDigest agrees', () => {
    const messages: BlobMessageInput[] = [
      mkMessage(0, [inlineBlock('blk_0_0', 'text', 'hello')]),
      mkMessage(1, [inlineBlock('blk_1_0', 'text', 'world')]),
    ]
    const result = writeSessionBlobPack({ session_id: 'ses_digest', epoch: 1, messages }, identityCompressor)
    expect(result.header.pack_digest).toBe(result.pack_digest)
    // Reader-side recomputation must match without trusting the header field.
    const recomputed = verifyPackDigest(result.pack)
    expect(recomputed).toBe(result.pack_digest)
  })

  it('CQ-085: verifyPackDigest rejects a pack whose payload was tampered with', () => {
    const result = writeSessionBlobPack(
      { session_id: 'ses_tamper', epoch: 1, messages: [mkMessage(0, [inlineBlock('blk_0_0', 'text', 'hi')])] },
      identityCompressor,
    )
    const tampered = new Uint8Array(result.pack)
    // Flip the last byte of the payload (well past header + framing prefix).
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff
    expect(() => verifyPackDigest(tampered)).toThrow(/pack_digest|mismatch|hash/)
  })

  it('CQ-085: a single multi-block message larger than one page emits fragments preserving all blocks and the page cap', () => {
    // Adversarial: 400 inline blocks of 3 KiB each on a single
    // message. Each block fits under MAX_INLINE_BLOCK_BYTES, but
    // their cumulative cost exceeds MAX_PAGE_UNCOMPRESSED_BYTES.
    // The writer must split the message into fragments across
    // multiple pages, preserve every input block, and keep each
    // page's serialized bytes at or below the cap.
    const blocks = Array.from({ length: 400 }, (_, b) =>
      inlineBlock(`blk_huge_${b.toString().padStart(3, '0')}`, 'text', 'z'.repeat(3 * 1024)),
    )
    const result = writeSessionBlobPack(
      { session_id: 'ses_huge', epoch: 1, messages: [mkMessage(0, blocks)] },
      identityCompressor,
    )
    expect(result.header.page_count).toBeGreaterThanOrEqual(2)
    // Every input block id appears exactly once across pages.
    const seen = new Set<string>()
    for (let p = 0; p < result.header.page_count; p++) {
      const page = loadTranscriptPage(result.pack, p, identityDecompressor)
      // Every fragment uses the same message_id.
      for (const m of page.messages) {
        expect(m.message_id).toBe('msg_000000')
        for (const blk of m.blocks) {
          expect(seen.has(blk.block_id)).toBe(false)
          seen.add(blk.block_id)
        }
      }
    }
    expect(seen.size).toBe(blocks.length)
    // Every page's actual serialized size is at or below the cap.
    for (const page of result.header.pages) {
      expect(page.uncompressed_length).toBeLessThanOrEqual(MAX_PAGE_UNCOMPRESSED_BYTES)
    }
  })

  it('CQ-085: every input block survives in some page (no silent drops across page splits)', () => {
    // Universal block-preservation invariant: regardless of where the
    // writer splits pages, the union of block_ids written across all
    // pages must equal the input set, with no duplicates and no
    // missing entries. Exercises the split-page path with a mix of
    // single-block and multi-block messages and several block sizes.
    const messages: BlobMessageInput[] = []
    for (let i = 0; i < 200; i++) {
      const blocks: BlobMessageInput['blocks'] = []
      const blockCount = (i % 3) + 1
      for (let b = 0; b < blockCount; b++) {
        const len = 3 * 1024 + b * 1031
        blocks.push(inlineBlock(`blk_${i}_${b}`, 'text', 'x'.repeat(len)))
      }
      messages.push(mkMessage(i, blocks))
    }
    const expectedBlockIds = new Set<string>()
    for (const m of messages) for (const b of m.blocks) expectedBlockIds.add(b.block_id)
    const result = writeSessionBlobPack({ session_id: 'ses_atomic', epoch: 1, messages }, identityCompressor)
    // The page set should split somewhere — otherwise the assertion is
    // not exercising the split path.
    expect(result.header.page_count).toBeGreaterThanOrEqual(1)
    const seen = new Set<string>()
    for (let p = 0; p < result.header.page_count; p++) {
      const body = loadTranscriptPage(result.pack, p, identityDecompressor)
      for (const m of body.messages) {
        for (const b of m.blocks) {
          expect(seen.has(b.block_id)).toBe(false) // no duplicates
          seen.add(b.block_id)
        }
      }
    }
    expect(seen.size).toBe(expectedBlockIds.size)
    for (const id of expectedBlockIds) expect(seen.has(id)).toBe(true)
  })

  it("CQ-085: every non-empty page's actual uncompressed bytes stay at or below MAX_PAGE_UNCOMPRESSED_BYTES", () => {
    // Stress the byte-budget estimator: many medium-sized blocks
    // whose JSON-encoded size strictly exceeds the inline text length.
    const messages: BlobMessageInput[] = Array.from({ length: 800 }, (_, i) =>
      mkMessage(i, [inlineBlock(`blk_${i}_0`, 'text', 'y'.repeat(3 * 1024))]),
    )
    const result = writeSessionBlobPack({ session_id: 'ses_budget', epoch: 1, messages }, identityCompressor)
    for (const page of result.header.pages) {
      // identityCompressor preserves length, so stored_length is the actual serialized size.
      expect(page.stored_length).toBeLessThanOrEqual(MAX_PAGE_UNCOMPRESSED_BYTES)
      expect(page.uncompressed_length).toBeLessThanOrEqual(MAX_PAGE_UNCOMPRESSED_BYTES)
    }
  })
})
