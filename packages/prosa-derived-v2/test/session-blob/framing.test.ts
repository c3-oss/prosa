// SessionBlobPackV2 framing tests — CQ-084 round-trip + edge cases.

import { describe, expect, it } from 'vitest'

import {
  SESSION_BLOB_MAGIC,
  SESSION_BLOB_VERSION,
  canonicalJsonBytes,
  decodeSessionBlobFrame,
  encodeSessionBlobFrame,
} from '../../src/session-blob/framing.js'

describe('SessionBlobPackV2 framing', () => {
  it('magic constant fits the 16-byte fixed prefix slot (CQ-084)', () => {
    // The original draft used "prosa-session-blob" (18 bytes), which
    // would silently truncate during `encodeInto` and fail the
    // decoder's full-string comparison. The chosen magic must be
    // exactly 16 bytes so encode/decode round-trip self-consistently.
    expect(SESSION_BLOB_MAGIC.length).toBeLessThanOrEqual(16)
  })

  it('encode/decode round-trips header + payload + flags', () => {
    const headerBytes = canonicalJsonBytes({ epoch: 1, page_count: 2, note: 'hello' })
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const flags = 0x000a
    const buf = encodeSessionBlobFrame({ headerBytes, payload, flags })
    const decoded = decodeSessionBlobFrame(buf)
    expect(decoded.magic).toBe(SESSION_BLOB_MAGIC)
    expect(decoded.version).toBe(SESSION_BLOB_VERSION)
    expect(decoded.flags).toBe(flags)
    expect(decoded.headerBytes).toEqual(headerBytes)
    expect(decoded.payload).toEqual(payload)
    // headerHash is computed over the header bytes.
    expect(decoded.headerHash.length).toBe(32)
  })

  it('rejects header tampering via the blake3 binding', () => {
    const headerBytes = canonicalJsonBytes({ epoch: 1, page_count: 0 })
    const payload = new Uint8Array([42])
    const buf = encodeSessionBlobFrame({ headerBytes, payload })
    // Flip a single byte in the header region (after the 56-byte fixed
    // prefix). The decoder must reject the frame.
    const tampered = new Uint8Array(buf)
    tampered[56] = tampered[56]! ^ 0xff
    expect(() => decodeSessionBlobFrame(tampered)).toThrow(/header_blake3 mismatch/)
  })

  it('rejects a buffer shorter than the fixed prefix', () => {
    const shortBuf = new Uint8Array(10)
    expect(() => decodeSessionBlobFrame(shortBuf)).toThrow(/buffer too short/)
  })

  it('rejects a header_len that exceeds the buffer', () => {
    // Build a valid frame, then truncate so header_len overruns.
    const headerBytes = canonicalJsonBytes({ epoch: 1, page_count: 0, padding: 'x'.repeat(1024) })
    const payload = new Uint8Array([1, 2, 3])
    const buf = encodeSessionBlobFrame({ headerBytes, payload })
    const truncated = buf.slice(0, 80) // drop most of the header bytes + payload
    expect(() => decodeSessionBlobFrame(truncated)).toThrow(/header_len/)
  })

  it('rejects an unexpected magic value (foreign pack mistakenly decoded)', () => {
    const headerBytes = canonicalJsonBytes({ epoch: 1, page_count: 0 })
    const payload = new Uint8Array([0])
    const buf = encodeSessionBlobFrame({ headerBytes, payload })
    const swapped = new Uint8Array(buf)
    // Replace the first byte of the magic.
    swapped[0] = swapped[0]! ^ 0xff
    expect(() => decodeSessionBlobFrame(swapped)).toThrow(/magic mismatch/)
  })

  it('canonicalJsonBytes emits stable key ordering for nested objects', () => {
    const a = canonicalJsonBytes({ b: 2, a: 1, nested: { z: 1, y: 2 } })
    const b = canonicalJsonBytes({ a: 1, nested: { y: 2, z: 1 }, b: 2 })
    expect(a).toEqual(b)
    // Spot-check the literal output so a future change to the encoder
    // surfaces as a visible diff.
    expect(new TextDecoder().decode(a)).toBe('{"a":1,"b":2,"nested":{"y":2,"z":1}}')
  })

  it('canonicalJsonBytes drops `undefined` fields while preserving `null`', () => {
    const out = canonicalJsonBytes({ a: 1, b: undefined, c: null })
    expect(new TextDecoder().decode(out)).toBe('{"a":1,"c":null}')
  })
})
