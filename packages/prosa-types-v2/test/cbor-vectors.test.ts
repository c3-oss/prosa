// CQ-018: hand-traceable conformance vectors.
//
// Each vector below is small enough to step through by hand against
// RFC 8949 §4.2.1 (deterministic CBOR) and the canonical encoding rules
// in CANONICAL.md. An independent implementation following the same
// rules must reproduce each byte sequence exactly.
//
// The BLAKE3 vector at the bottom is one of the spec's known test
// vectors (BLAKE3 of zero bytes), which validates that the underlying
// hash library (@noble/hashes/blake3) matches the spec — without that,
// every Merkle leaf would silently drift.

import { blake3 } from '@noble/hashes/blake3'
import { describe, expect, it } from 'vitest'

import { canonicalCbor, toHex } from '../src/canonical.js'

function expectBytes(out: Uint8Array, hex: string): void {
  expect(toHex(out)).toBe(hex.replaceAll(/\s+/g, ''))
}

describe('canonical CBOR hand-traceable vectors (CQ-018)', () => {
  // Array of 1 null:
  //   array header (major 4, length 1)               = 0x80 | 1   = 0x81
  //   null (simple value 22)                          = 0xf6
  //   --------------------------------------------------------------
  //   bytes                                           = 81 f6
  it('[null] = 81 f6', () => {
    expectBytes(canonicalCbor([null]), '81 f6')
  })

  // Array of 2 booleans:
  //   array header (major 4, length 2)               = 0x82
  //   true  (simple value 21)                         = 0xf5
  //   false (simple value 20)                         = 0xf4
  //   --------------------------------------------------------------
  //   bytes                                           = 82 f5 f4
  it('[true, false] = 82 f5 f4', () => {
    expectBytes(canonicalCbor([true, false]), '82 f5 f4')
  })

  // Array of 1 small positive integer:
  //   array header                                    = 0x81
  //   integer 0 (major 0, immediate value 0)         = 0x00
  //   --------------------------------------------------------------
  //   bytes                                           = 81 00
  it('[0] = 81 00', () => {
    expectBytes(canonicalCbor([0]), '81 00')
  })

  // Boundary inputs for integer width selection:
  //
  //   [23]   → 0x81 0x17                 (last inline value)
  //   [24]   → 0x81 0x18 0x18            (first 1-byte argument)
  //   [255]  → 0x81 0x18 0xff
  //   [256]  → 0x81 0x19 0x01 0x00       (2-byte argument)
  //   [65535]→ 0x81 0x19 0xff 0xff
  //   [65536]→ 0x81 0x1a 0x00 0x01 0x00 0x00 (4-byte argument)
  it('integer width boundaries', () => {
    expectBytes(canonicalCbor([23]), '81 17')
    expectBytes(canonicalCbor([24]), '81 18 18')
    expectBytes(canonicalCbor([255]), '81 18 ff')
    expectBytes(canonicalCbor([256]), '81 19 01 00')
    expectBytes(canonicalCbor([65535]), '81 19 ff ff')
    expectBytes(canonicalCbor([65536]), '81 1a 00 01 00 00')
  })

  // Negative integers use major type 1 with argument = -1 - n:
  //   [-1]   → 0x81 0x20    (major 1 inline, argument 0  ↔ -1)
  //   [-24]  → 0x81 0x37    (major 1 inline, argument 23 ↔ -24)
  //   [-25]  → 0x81 0x38 0x18  (1-byte argument 24      ↔ -25)
  //   [-256] → 0x81 0x38 0xff
  //   [-257] → 0x81 0x39 0x01 0x00
  it('negative integer width boundaries', () => {
    expectBytes(canonicalCbor([-1]), '81 20')
    expectBytes(canonicalCbor([-24]), '81 37')
    expectBytes(canonicalCbor([-25]), '81 38 18')
    expectBytes(canonicalCbor([-256]), '81 38 ff')
    expectBytes(canonicalCbor([-257]), '81 39 01 00')
  })

  // Array of 1 single-character ASCII string:
  //   array header                                    = 0x81
  //   string header (major 3, length 1)               = 0x60 | 1   = 0x61
  //   UTF-8 byte for 'a'                              = 0x61
  //   --------------------------------------------------------------
  //   bytes                                           = 81 61 61
  it('["a"] = 81 61 61', () => {
    expectBytes(canonicalCbor(['a']), '81 61 61')
  })

  // Array of 1 12-character ASCII string:
  //   array header                                    = 0x81
  //   string header (major 3, length 12)              = 0x60 | 12 = 0x6c
  //   UTF-8 bytes for 'hello, world':
  //     h e l l o ,  SP w o r l d
  //     68 65 6c 6c 6f 2c 20 77 6f 72 6c 64
  it('["hello, world"]', () => {
    expectBytes(canonicalCbor(['hello, world']), '81 6c 68 65 6c 6c 6f 2c 20 77 6f 72 6c 64')
  })

  // NFC normalization is applied: 'é' written as e + combining acute (NFD)
  // must encode the same as the precomposed NFC form. The single canonical
  // UTF-8 byte sequence for NFC 'é' is 0xc3 0xa9, so:
  //   ["é"] → 0x81 0x62 0xc3 0xa9
  it('NFC normalization yields a 2-byte UTF-8 sequence', () => {
    // 'é' typed as e (U+0065) + combining acute (U+0301) → NFC 'é' (U+00E9)
    const nfd = 'é'
    expectBytes(canonicalCbor([nfd]), '81 62 c3 a9')
  })

  // Empty array:
  //   array header (major 4, length 0)                = 0x80
  it('[] = 80', () => {
    expectBytes(canonicalCbor([]), '80')
  })

  // A 2-element heterogeneous array:
  //   array header (length 2)                         = 0x82
  //   integer 1                                       = 0x01
  //   string header (length 1) + 'x' (0x78)           = 0x61 0x78
  it('[1, "x"] = 82 01 61 78', () => {
    expectBytes(canonicalCbor([1, 'x']), '82 01 61 78')
  })
})

describe('BLAKE3 spec vector (CQ-018)', () => {
  // Canonical BLAKE3 test vector for the empty input (RFC 9106-track,
  // BLAKE3 spec test vectors):
  //   blake3('') = af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262
  // If this assertion ever flips, the underlying hash library no longer
  // matches the BLAKE3 spec and every prosa Merkle leaf in the system is
  // suspect.
  it('blake3("") matches the spec test vector', () => {
    const out = blake3(new Uint8Array(0))
    expect(toHex(out)).toBe('af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262')
  })

  // Second BLAKE3 spec vector — single zero byte:
  //   blake3([0x00]) = 2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213
  it('blake3([0x00]) matches the spec test vector', () => {
    const out = blake3(Uint8Array.of(0))
    expect(toHex(out)).toBe('2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213')
  })
})
