// SessionBlobPackV2 production zstd round-trip tests.
//
// The byte-layout tests use the identity compressor pair to exercise
// framing, hashing, and pagination without the native binding. These
// tests cover the production path: pages are compressed with the
// `prosa-bundle-v2` zstd wrapper, written into the pack, then read
// back via `loadTranscriptPage` / `iterateTranscript`. Asserts:
//
//   - Decompressed bytes match the original message bodies.
//   - Stored bytes are smaller than uncompressed bytes for compressible
//     content (sanity: zstd is actually running, not pass-through).
//   - `pack_digest` re-verifies from the bytes alone via
//     `verifyPackDigest`.
//   - The reader rejects a tampered compressed-bytes region (per-page
//     `stored_hash` mismatch).
//   - Cross-page iteration works end-to-end on a real zstd pack.

import { describe, expect, it } from 'vitest'

import { iterateTranscript, loadTranscriptPage, verifyPackDigest } from '../../src/session-blob/reader.js'
import { type BlobMessageInput, writeSessionBlobPack } from '../../src/session-blob/writer.js'
import { zstdSessionBlobCompressor, zstdSessionBlobDecompressor } from '../../src/session-blob/zstd.js'

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

describe('SessionBlobPackV2 production zstd compressor + decompressor', () => {
  it('round-trips a small session through real zstd', () => {
    const messages = [
      mkMessage(0, [inlineBlock('blk_0_0', 'text', 'hello')]),
      mkMessage(1, [inlineBlock('blk_1_0', 'text', 'world')]),
    ]
    const result = writeSessionBlobPack({ session_id: 'ses_zstd_small', epoch: 1, messages }, zstdSessionBlobCompressor)

    expect(result.header.compression).toBe('zstd')
    expect(verifyPackDigest(result.pack)).toBe(result.pack_digest)

    const page0 = loadTranscriptPage(result.pack, 0, zstdSessionBlobDecompressor)
    expect(page0.messages).toHaveLength(2)
    expect(page0.messages[0]!.message_id).toBe('msg_000000')
    expect(page0.messages[0]!.blocks[0]!.body).toEqual({
      kind: 'inline',
      text: 'hello',
      byte_length: 5,
    })
  })

  it('actually compresses (stored_length < uncompressed_length for highly repetitive content)', () => {
    // Highly redundant block body; zstd should shrink it dramatically.
    const filler = 'A'.repeat(8000)
    const messages = [mkMessage(0, [inlineBlock('blk_0_0', 'text', filler)])]
    const result = writeSessionBlobPack({ session_id: 'ses_zstd_compr', epoch: 1, messages }, zstdSessionBlobCompressor)

    const pageRef = result.header.pages[0]!
    expect(pageRef.stored_length).toBeLessThan(pageRef.uncompressed_length)
    // Sanity: a 99% redundant 8 KiB body should compress to well
    // under half the uncompressed body. This is a loose bound; the
    // test fails only if zstd is genuinely not running.
    expect(pageRef.stored_length).toBeLessThan(pageRef.uncompressed_length / 2)
  })

  it('rejects a tampered compressed page (per-page stored_hash mismatch)', () => {
    const messages = [
      mkMessage(0, [inlineBlock('blk_0_0', 'text', 'pristine bytes here')]),
      mkMessage(1, [inlineBlock('blk_1_0', 'text', 'more pristine bytes here')]),
    ]
    const result = writeSessionBlobPack(
      { session_id: 'ses_zstd_tamper', epoch: 1, messages },
      zstdSessionBlobCompressor,
    )

    // Flip a byte inside the compressed payload (deep, not in the
    // framing magic / canonical-JSON header). The stored_hash binds
    // the compressed bytes so the reader must reject before
    // attempting decompression.
    const tampered = new Uint8Array(result.pack)
    const flipAt = tampered.length - 4
    tampered[flipAt] = (tampered[flipAt]! + 1) & 0xff

    expect(() => loadTranscriptPage(tampered, 0, zstdSessionBlobDecompressor)).toThrow(/stored_hash|mismatch/i)
  })

  it('cross-page iteration walks every message on a real zstd pack', () => {
    // Enough messages to span multiple pages even with high
    // compressibility — use distinct content per message so each
    // page payload is genuinely populated.
    const messages = Array.from({ length: 200 }, (_, i) =>
      mkMessage(i, [inlineBlock(`blk_${i}_0`, 'text', `message number ${i.toString().padStart(4, '0')} body`)]),
    )
    const result = writeSessionBlobPack({ session_id: 'ses_zstd_iter', epoch: 7, messages }, zstdSessionBlobCompressor)

    const collected: number[] = []
    for (const msg of iterateTranscript(result.pack, zstdSessionBlobDecompressor)) {
      collected.push(msg.ordinal)
    }
    expect(collected).toHaveLength(200)
    expect(collected[0]).toBe(0)
    expect(collected[199]).toBe(199)
    // Strictly ascending — the iterator yields in ordinal order.
    for (let i = 1; i < collected.length; i++) {
      expect(collected[i]).toBeGreaterThan(collected[i - 1]!)
    }
  })

  it('decompressor rejects a malicious frame with windowLog > canonical max', () => {
    // The bundle-v2 wrapper's `parseZstdFrameWindowLog` rejects a
    // crafted frame demanding `windowLog > 23`. We exercise that path
    // by handing the decompressor a hand-built frame header with a
    // window descriptor that demands `windowLog = 31` (max representable).
    //
    // Layout: regular zstd frame magic 0x28 0xB5 0x2F 0xFD, FHD = 0x00
    // (FCS flag = 0 → no FCS field; Single_Segment_flag = 0 → Window
    // descriptor present), then Window_Descriptor byte 0xF8
    // (exponent = 0x1F (31), mantissa = 0 → window log = 31 + 10 = 41).
    const maliciousFrame = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xf8])
    expect(() => zstdSessionBlobDecompressor(maliciousFrame)).toThrow(/windowLog/i)
  })
})
