// Lane 4 gate: zstd window cap enforced at validation time.
//
// We do not run the zstd decoder in this test; the validator parses
// the frame header directly so a malicious pack cannot push the
// decoder to allocate before being rejected. Two fixture sources are
// used:
//
// - Real zstd-napi output exercises the parser against valid
//   production bytes (small payloads, which zstd encodes as
//   Single_Segment frames where window = content_size).
// - Hand-crafted frame headers exercise the Window_Descriptor parse
//   path: zstd-napi prefers Single_Segment for the small inputs we
//   can afford in a unit test, so we synthesise frame headers with
//   the desired (exponent, mantissa) directly. The validator never
//   decodes the body, so the rest of the bytes do not need to be a
//   valid zstd block.

import { describe, expect, it } from 'vitest'
import { Compressor } from 'zstd-napi'
import {
  DEFAULT_MAX_ZSTD_WINDOW_BYTES,
  PackZstdWindowTooLargeError,
  ZSTD_MAGIC,
  parseZstdFrameHeader,
  validateZstdWindow,
} from '../../src/v2/upload/validate.js'

function compressDefault(input: Buffer): Buffer {
  return new Compressor().compress(input)
}

/**
 * Build the first bytes of a zstd frame with a chosen Window_Descriptor.
 * No FCS, no DID, single_segment cleared so the parser walks the
 * Window_Descriptor branch.
 */
function craftFrameHeader(exponent: number, mantissa: number): Uint8Array {
  if (exponent < 0 || exponent > 31) throw new Error('exponent out of range')
  if (mantissa < 0 || mantissa > 7) throw new Error('mantissa out of range')
  const fhd = 0b00000000 // fcs=0, single_segment=0, did=0
  const wd = ((exponent & 0b11111) << 3) | (mantissa & 0b111)
  return new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, fhd, wd])
}

describe('zstd window cap (PACK_ZSTD_WINDOW_TOO_LARGE)', () => {
  it('parses the frame header of a default-window pack', () => {
    const bytes = compressDefault(Buffer.from('hello world hello world hello world hello world'))
    const summary = parseZstdFrameHeader(new Uint8Array(bytes))
    const magic = (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8) | ((bytes[2] ?? 0) << 16) | ((bytes[3] ?? 0) << 24)
    expect(magic >>> 0).toBe(ZSTD_MAGIC)
    expect(summary.windowBytes).toBeGreaterThan(0)
    expect(summary.headerByteLength).toBeGreaterThanOrEqual(5)
  })

  it('accepts a single-segment zstd-napi frame (window === content_size)', () => {
    const compressed = compressDefault(Buffer.from('hello'))
    const summary = validateZstdWindow(new Uint8Array(compressed))
    expect(summary.singleSegment).toBe(true)
    // 5 byte payload < 8 MiB cap.
    expect(summary.windowBytes).toBeLessThanOrEqual(DEFAULT_MAX_ZSTD_WINDOW_BYTES)
  })

  it('decodes a synthesised Window_Descriptor (exponent 13, mantissa 0) as 8 MiB exactly', () => {
    // 2 ** (10 + 13) = 8 388 608 bytes = the cap.
    const header = craftFrameHeader(13, 0)
    const summary = parseZstdFrameHeader(header)
    expect(summary.singleSegment).toBe(false)
    expect(summary.windowBytes).toBe(8 * 1024 * 1024)
    // Equal to cap → must NOT throw (the check is strictly `>`).
    const sameSummary = validateZstdWindow(header)
    expect(sameSummary.windowBytes).toBe(8 * 1024 * 1024)
  })

  it('rejects a frame whose Window_Descriptor declares 16 MiB (exponent 14)', () => {
    const header = craftFrameHeader(14, 0)
    let thrown: unknown = null
    try {
      validateZstdWindow(header)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(PackZstdWindowTooLargeError)
    const err = thrown as PackZstdWindowTooLargeError
    expect(err.code).toBe('PACK_ZSTD_WINDOW_TOO_LARGE')
    expect(err.maxWindowBytes).toBe(DEFAULT_MAX_ZSTD_WINDOW_BYTES)
    expect(err.actualWindowBytes).toBe(16 * 1024 * 1024)
    expect(err.details.action).toBe('reencode_pack')
  })

  it('rejects a frame with exponent 17 (128 MiB window) far above the cap', () => {
    const header = craftFrameHeader(17, 0)
    expect(() => validateZstdWindow(header)).toThrow(PackZstdWindowTooLargeError)
  })

  it('honors mantissa in the Window_Descriptor (exponent 13, mantissa 1 = 9 MiB)', () => {
    // base = 8 MiB; base/8 = 1 MiB; window = 8 + 1 = 9 MiB → exceeds the cap.
    const header = craftFrameHeader(13, 1)
    const summary = parseZstdFrameHeader(header)
    expect(summary.windowBytes).toBe(9 * 1024 * 1024)
    expect(() => validateZstdWindow(header)).toThrow(PackZstdWindowTooLargeError)
  })

  it('honors a caller-supplied tighter cap on a real zstd-napi frame', () => {
    // The validator must enforce the supplied `maxWindowBytes`, even when the
    // zstd-napi-produced single-segment frame is small enough for the default.
    const compressed = compressDefault(Buffer.alloc(64 * 1024, 'c'))
    expect(() => validateZstdWindow(new Uint8Array(compressed), { maxWindowBytes: 32 * 1024 })).toThrow(
      PackZstdWindowTooLargeError,
    )
  })

  it('throws ZSTD_BAD_MAGIC for non-zstd bytes', () => {
    const bogus = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04])
    let thrown: unknown = null
    try {
      validateZstdWindow(bogus)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeTruthy()
    expect((thrown as { code?: string }).code).toBe('ZSTD_BAD_MAGIC')
  })

  it('throws ZSTD_HEADER_TRUNCATED when there are not enough bytes for the magic', () => {
    let thrown: unknown = null
    try {
      validateZstdWindow(new Uint8Array([0x28]))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeTruthy()
    expect((thrown as { code?: string }).code).toBe('ZSTD_HEADER_TRUNCATED')
  })

  it('reports the magic constant unambiguously', () => {
    expect(ZSTD_MAGIC).toBe(0xfd2fb528)
  })
})
