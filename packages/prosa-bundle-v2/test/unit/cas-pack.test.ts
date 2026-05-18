import { describe, expect, it } from 'vitest'

import { CAS_PACK_MAGIC, CasPackVerifyError, buildCasPack, verifyCasPack } from '../../src/pack/cas-pack.js'
import { decodePackFrame } from '../../src/pack/framing.js'
import { ZSTD_MAX_WINDOW_LOG } from '../../src/pack/zstd.js'

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

describe('CAS pack (build/verify)', () => {
  it('round-trips a single-entry pack', () => {
    const inputs = [{ bytes: bytes('hello, world') }]
    const built = buildCasPack(inputs, { createdAt: '2025-01-02T03:04:05.123Z' })
    const verified = verifyCasPack(built.bytes)
    expect(verified.entries.length).toBe(1)
    const e = verified.entries[0]
    if (!e) throw new Error('expected entry')
    expect(new TextDecoder().decode(e.uncompressed)).toBe('hello, world')
    expect(e.entry.object_id).toMatch(/^blake3:[0-9a-f]{64}$/)
    expect(e.entry.uncompressed_hash).toBe(e.entry.object_id)
  })

  it('round-trips a multi-entry pack and assigns monotonic offsets', () => {
    const inputs = [{ bytes: bytes('alpha') }, { bytes: bytes('beta-beta-beta') }, { bytes: bytes('gamma') }]
    const built = buildCasPack(inputs, { createdAt: '2025-01-02T03:04:05.123Z' })
    const v = verifyCasPack(built.bytes)
    expect(v.entries.length).toBe(3)
    let prevEnd = 0
    for (const { entry } of v.entries) {
      expect(entry.stored_offset).toBe(prevEnd)
      prevEnd = entry.stored_offset + entry.stored_length
    }
  })

  it('produces a frame carrying the expected magic and version', () => {
    const built = buildCasPack([{ bytes: bytes('x') }], { createdAt: '2025-01-02T03:04:05.123Z' })
    const frame = decodePackFrame(built.bytes)
    expect(frame.magic).toBe(CAS_PACK_MAGIC)
    expect(frame.version).toBe(2)
  })

  it('rejects build with windowLog > 23 (canonical pin, L7)', () => {
    expect(() =>
      buildCasPack([{ bytes: bytes('x') }], {
        createdAt: '2025-01-02T03:04:05.123Z',
        zstdWindowLog: ZSTD_MAX_WINDOW_LOG + 1,
      }),
    ).toThrow(/windowLog|WindowLog/)
  })

  it('rejects a pack whose header declares window_log > 23', () => {
    // Build a legit pack, then mutate the header JSON to set window_log = 24
    // without recomputing the digest. The framing layer's header BLAKE3 will
    // also fail; verify the order: framing first, content second.
    const built = buildCasPack([{ bytes: bytes('x') }], { createdAt: '2025-01-02T03:04:05.123Z' })
    const buf = new Uint8Array(built.bytes)
    const headerStart = 56
    const dec = new TextDecoder().decode(buf.subarray(headerStart, headerStart + 200))
    const malformed = dec.replace('"zstd_window_log":21', '"zstd_window_log":24')
    const mutated = new Uint8Array(buf.byteLength + malformed.length - 200)
    mutated.set(buf.subarray(0, headerStart))
    new TextEncoder().encodeInto(malformed, mutated.subarray(headerStart))
    expect(() => verifyCasPack(mutated)).toThrow()
  })

  it('rejects tampered payload (stored_hash mismatch)', () => {
    const built = buildCasPack([{ bytes: bytes('payload-bytes') }], {
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    const tampered = new Uint8Array(built.bytes)
    // Find the start of the payload (FIXED_PREFIX_LEN + header_len from the
    // header_len u32 at offset 20).
    const view = new DataView(tampered.buffer, tampered.byteOffset, tampered.byteLength)
    const headerLen = view.getUint32(20, true)
    const payloadStart = 56 + headerLen
    // Flip one byte.
    if (payloadStart < tampered.length) {
      tampered[payloadStart] = (tampered[payloadStart] as number) ^ 0xff
    }
    expect(() => verifyCasPack(tampered)).toThrow(CasPackVerifyError)
  })

  it('deduplicates: identical bytes produce identical object_id across runs', () => {
    const a = buildCasPack([{ bytes: bytes('same') }], { createdAt: '2025-01-02T03:04:05.123Z' })
    const b = buildCasPack([{ bytes: bytes('same') }], { createdAt: '2025-01-02T03:04:05.123Z' })
    const av = verifyCasPack(a.bytes)
    const bv = verifyCasPack(b.bytes)
    expect(av.entries[0]!.entry.object_id).toBe(bv.entries[0]!.entry.object_id)
  })
})
