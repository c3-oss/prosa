// SessionBlobPackV2 cross-page transcript iterator tests.
//
// `iterateTranscript()` walks every message in the pack in canonical
// ordinal order, coalescing fragments that share `(message_id,
// ordinal)` across adjacent pages. This is the read-side primitive
// that CLI / MCP / web reads will use to materialize a transcript
// from a pack written by `writeSessionBlobPack`.

import { describe, expect, it } from 'vitest'

import {
  identityCompressor,
  identityDecompressor,
  iterateTranscript,
  loadTranscript,
} from '../../src/session-blob/reader.js'
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
    timestamp: `2026-05-19T00:00:${(i % 60).toString().padStart(2, '0')}.000Z`,
    turn_id: `tur_${Math.floor(i / 2)}`,
    blocks,
  }
}

describe('SessionBlobPackV2 cross-page transcript iterator', () => {
  it('yields nothing for an empty pack', () => {
    const result = writeSessionBlobPack({ session_id: 'ses_empty', epoch: 1, messages: [] }, identityCompressor)
    const collected = loadTranscript(result.pack, identityDecompressor)
    expect(collected).toEqual([])
  })

  it('yields messages in ordinal order from a single-page pack', () => {
    const messages: BlobMessageInput[] = [
      mkMessage(0, [inlineBlock('blk_0_0', 'text', 'hello')]),
      mkMessage(1, [inlineBlock('blk_1_0', 'text', 'world')]),
      mkMessage(2, [inlineBlock('blk_2_0', 'thinking', 'reasoning'), inlineBlock('blk_2_1', 'text', 'I see it now.')]),
    ]
    const result = writeSessionBlobPack({ session_id: 'ses_single', epoch: 1, messages }, identityCompressor)
    expect(result.header.page_count).toBe(1)

    const collected = loadTranscript(result.pack, identityDecompressor)
    expect(collected).toHaveLength(3)
    expect(collected.map((m) => m.ordinal)).toEqual([0, 1, 2])
    expect(collected.map((m) => m.message_id)).toEqual(['msg_000000', 'msg_000001', 'msg_000002'])
    expect(collected[2]!.blocks).toHaveLength(2)
    // Every message lives on exactly one page when no fragmenting occurs.
    expect(collected.every((m) => m.page_indices.length === 1 && m.page_indices[0] === 0)).toBe(true)
  })

  it('yields messages in ordinal order across multiple pages', () => {
    const messages: BlobMessageInput[] = Array.from({ length: 600 }, (_, i) =>
      mkMessage(i, [inlineBlock(`blk_${i}_0`, 'text', 'x'.repeat(2048))]),
    )
    const result = writeSessionBlobPack({ session_id: 'ses_multi', epoch: 1, messages }, identityCompressor)
    expect(result.header.page_count).toBeGreaterThan(1)

    const collected = loadTranscript(result.pack, identityDecompressor)
    expect(collected).toHaveLength(600)
    // Ordinals are dense + monotonic.
    expect(collected.map((m) => m.ordinal)).toEqual(Array.from({ length: 600 }, (_, i) => i))
    // No message is split across pages in this scenario.
    for (const m of collected) expect(m.page_indices).toHaveLength(1)
    // page_indices are monotone non-decreasing in iteration order.
    let lastPage = -1
    for (const m of collected) {
      expect(m.page_indices[0]!).toBeGreaterThanOrEqual(lastPage)
      lastPage = m.page_indices[0]!
    }
  })

  it('coalesces fragments of a single oversized message back into one TranscriptMessage', () => {
    // Reuse the CQ-085 adversarial fixture: 400 inline blocks of 3
    // KiB each on a single message. Writer emits multiple fragments
    // sharing the same `message_id` / `ordinal`. The iterator must
    // join them.
    const blocks = Array.from({ length: 400 }, (_, b) =>
      inlineBlock(`blk_huge_${b.toString().padStart(3, '0')}`, 'text', 'z'.repeat(3 * 1024)),
    )
    const result = writeSessionBlobPack(
      { session_id: 'ses_huge', epoch: 1, messages: [mkMessage(0, blocks)] },
      identityCompressor,
    )
    expect(result.header.page_count).toBeGreaterThanOrEqual(2)

    const collected = loadTranscript(result.pack, identityDecompressor)
    expect(collected).toHaveLength(1)
    const [msg] = collected
    expect(msg!.message_id).toBe('msg_000000')
    expect(msg!.ordinal).toBe(0)
    expect(msg!.blocks).toHaveLength(400)
    // Block-id order is preserved end-to-end (fragments concatenate in
    // page order, and blocks within a fragment keep their input order).
    expect(msg!.blocks.map((b) => b.block_id)).toEqual(blocks.map((b) => b.block_id))
    // The fragments must come from at least 2 distinct pages.
    expect(new Set(msg!.page_indices).size).toBeGreaterThanOrEqual(2)
  })

  it('respects startOrdinal / endOrdinal range filters', () => {
    const messages: BlobMessageInput[] = Array.from({ length: 600 }, (_, i) =>
      mkMessage(i, [inlineBlock(`blk_${i}_0`, 'text', 'x'.repeat(2048))]),
    )
    const result = writeSessionBlobPack({ session_id: 'ses_range', epoch: 1, messages }, identityCompressor)
    expect(result.header.page_count).toBeGreaterThan(1)

    const middle = loadTranscript(result.pack, identityDecompressor, { startOrdinal: 100, endOrdinal: 199 })
    expect(middle.map((m) => m.ordinal)).toEqual(Array.from({ length: 100 }, (_, i) => 100 + i))

    const head = loadTranscript(result.pack, identityDecompressor, { endOrdinal: 9 })
    expect(head.map((m) => m.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

    const tail = loadTranscript(result.pack, identityDecompressor, { startOrdinal: 595 })
    expect(tail.map((m) => m.ordinal)).toEqual([595, 596, 597, 598, 599])

    // Empty window above the last ordinal yields nothing.
    const empty = loadTranscript(result.pack, identityDecompressor, { startOrdinal: 10_000 })
    expect(empty).toEqual([])
  })

  it('iterates lazily as a generator, allowing early termination', () => {
    const messages: BlobMessageInput[] = Array.from({ length: 600 }, (_, i) =>
      mkMessage(i, [inlineBlock(`blk_${i}_0`, 'text', 'x'.repeat(2048))]),
    )
    const result = writeSessionBlobPack({ session_id: 'ses_lazy', epoch: 1, messages }, identityCompressor)

    let taken = 0
    for (const msg of iterateTranscript(result.pack, identityDecompressor)) {
      taken += 1
      if (taken >= 5) break
      void msg
    }
    expect(taken).toBe(5)
  })

  it('verifies hashes through loadTranscriptPage — tampered payload bytes throw', () => {
    const messages: BlobMessageInput[] = [
      mkMessage(0, [inlineBlock('blk_0_0', 'text', 'untampered')]),
      mkMessage(1, [inlineBlock('blk_1_0', 'text', 'world')]),
    ]
    const result = writeSessionBlobPack({ session_id: 'ses_tamper', epoch: 1, messages }, identityCompressor)
    const tampered = new Uint8Array(result.pack)
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff

    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for (const _ of iterateTranscript(tampered, identityDecompressor)) {
        // drain
      }
    }).toThrow(/stored_hash|uncompressed_hash|mismatch/)
  })
})
