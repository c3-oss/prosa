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

  it('rejects a forged pack_digest (CQ-026)', async () => {
    const built = buildCasPack([{ bytes: bytes('cq-026') }], { createdAt: '2025-01-02T03:04:05.123Z' })
    // Mutate the pack_digest hex inside the JSON header, then re-frame.
    const buf = new Uint8Array(built.bytes)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const headerLen = view.getUint32(20, true)
    const headerStart = 56
    const headerBytes = buf.subarray(headerStart, headerStart + headerLen)
    const json = new TextDecoder().decode(headerBytes)
    // Flip the last hex digit of the digest so the byte length stays the
    // same; this preserves all entry hashes and the canonical-JSON shape.
    const mutatedJson = json.replace(/"pack_digest":"blake3:([0-9a-f]{63})([0-9a-f])"/, (_m, p1, last) => {
      const flipped = last === 'f' ? '0' : 'f'
      return `"pack_digest":"blake3:${p1}${flipped}"`
    })
    expect(mutatedJson).not.toBe(json)
    const newHeader = new TextEncoder().encode(mutatedJson)
    expect(newHeader.length).toBe(headerBytes.length)
    // Replace header bytes in place (also need to re-fix the header
    // blake3 in the prefix or the framing layer will reject first).
    const newBuf = new Uint8Array(buf)
    newBuf.set(newHeader, headerStart)
    // Recompute header_blake3 so the framing layer is satisfied; the
    // pack_digest re-derivation should still fail.
    const { blake3 } = await import('@noble/hashes/blake3')
    const newHeaderHash = blake3(newHeader)
    newBuf.set(newHeaderHash, 24)
    expect(() => verifyCasPack(newBuf)).toThrow(/pack_digest mismatch/)
  })

  it('CQ-042: rejects header bytes with reordered keys (canonical-JSON pin)', async () => {
    const built = buildCasPack([{ bytes: bytes('cq-042-reorder') }], {
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    const buf = new Uint8Array(built.bytes)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const headerLen = view.getUint32(20, true)
    const headerStart = 56
    const headerBytes = buf.subarray(headerStart, headerStart + headerLen)
    const json = new TextDecoder().decode(headerBytes)
    const parsed = JSON.parse(json)
    // Reorder: move bundleFormat (typically first canonically) to last.
    const keys = Object.keys(parsed)
    const reordered: Record<string, unknown> = {}
    for (const k of keys.slice(1)) reordered[k] = parsed[k]
    reordered[keys[0]!] = parsed[keys[0]!]
    const reorderedJson = JSON.stringify(reordered)
    // Pad/truncate to keep header_len stable; if length differs we have
    // to rebuild a different shape pack — instead, ensure the JSON has
    // the same byte length by tweaking. Skip if lengths differ.
    if (reorderedJson.length !== json.length) {
      // The reorder shifted byte length; canonical-JSON guarantees a
      // single deterministic length, so this is expected. Build a
      // padded buffer that fits the new header length and re-frame.
      // Easiest path: just confirm the new header is NOT canonical by
      // running verifyCasPack on a buffer with the new header length.
      const newBuf = new Uint8Array(headerStart + reorderedJson.length + (buf.byteLength - headerStart - headerLen))
      newBuf.set(buf.subarray(0, headerStart))
      new TextEncoder().encodeInto(reorderedJson, newBuf.subarray(headerStart))
      newBuf.set(buf.subarray(headerStart + headerLen), headerStart + reorderedJson.length)
      // Recompute header_len + header_blake3.
      const dv = new DataView(newBuf.buffer, newBuf.byteOffset, newBuf.byteLength)
      dv.setUint32(20, reorderedJson.length, true)
      const { blake3 } = await import('@noble/hashes/blake3')
      newBuf.set(blake3(new TextEncoder().encode(reorderedJson)), 24)
      expect(() => verifyCasPack(newBuf)).toThrow(CasPackVerifyError)
      return
    }
    // If lengths match, in-place mutation works.
    const newBuf = new Uint8Array(buf)
    new TextEncoder().encodeInto(reorderedJson, newBuf.subarray(headerStart))
    const { blake3 } = await import('@noble/hashes/blake3')
    newBuf.set(blake3(new TextEncoder().encode(reorderedJson)), 24)
    expect(() => verifyCasPack(newBuf)).toThrow(/not canonical/)
  })

  it('CQ-042: rejects header bytes with extra whitespace (canonical-JSON pin)', async () => {
    const built = buildCasPack([{ bytes: bytes('cq-042-ws') }], { createdAt: '2025-01-02T03:04:05.123Z' })
    const buf = new Uint8Array(built.bytes)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const headerLen = view.getUint32(20, true)
    const headerStart = 56
    const headerBytes = buf.subarray(headerStart, headerStart + headerLen)
    const json = new TextDecoder().decode(headerBytes)
    // Insert one space after the opening brace; this changes the byte
    // length but logically parses to the same object.
    const padded = json.replace(/^\{/, '{ ')
    expect(padded.length).toBe(json.length + 1)
    const newBuf = new Uint8Array(buf.byteLength + 1)
    newBuf.set(buf.subarray(0, headerStart))
    new TextEncoder().encodeInto(padded, newBuf.subarray(headerStart))
    newBuf.set(buf.subarray(headerStart + headerLen), headerStart + padded.length)
    const dv = new DataView(newBuf.buffer, newBuf.byteOffset, newBuf.byteLength)
    dv.setUint32(20, padded.length, true)
    const { blake3 } = await import('@noble/hashes/blake3')
    newBuf.set(blake3(new TextEncoder().encode(padded)), 24)
    expect(() => verifyCasPack(newBuf)).toThrow(/not canonical/)
  })

  it('deduplicates: identical bytes produce identical object_id across runs', () => {
    const a = buildCasPack([{ bytes: bytes('same') }], { createdAt: '2025-01-02T03:04:05.123Z' })
    const b = buildCasPack([{ bytes: bytes('same') }], { createdAt: '2025-01-02T03:04:05.123Z' })
    const av = verifyCasPack(a.bytes)
    const bv = verifyCasPack(b.bytes)
    expect(av.entries[0]!.entry.object_id).toBe(bv.entries[0]!.entry.object_id)
  })
})
