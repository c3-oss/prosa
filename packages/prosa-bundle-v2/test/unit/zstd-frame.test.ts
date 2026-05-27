// CQ-027: parseZstdFrameWindowLog actually parses the frame, and
// zstdDecompress refuses frames declaring windowLog > 23.

import { describe, expect, it } from 'vitest'

import { ZSTD_MAX_WINDOW_LOG, parseZstdFrameWindowLog, zstdCompress, zstdDecompress } from '../../src/pack/zstd.js'

const enc = new TextEncoder()

describe('parseZstdFrameWindowLog', () => {
  it('reads the window descriptor from a normal compressed frame', () => {
    const compressed = zstdCompress(enc.encode('hello world'.repeat(20)), { windowLog: 21 })
    const w = parseZstdFrameWindowLog(compressed)
    // The encoder may pick a smaller effective window if the input is
    // tiny; what matters is that the value is bounded by the requested
    // windowLog.
    expect(w).not.toBeNull()
    expect(w!).toBeLessThanOrEqual(21)
  })

  it('throws on non-zstd inputs', () => {
    expect(() => parseZstdFrameWindowLog(new Uint8Array([0, 0, 0, 0, 0, 0]))).toThrow(/not a zstd/)
  })

  it('rejects synthetic frame whose Window_Descriptor says windowLog 30', () => {
    // Build a tiny "zstd frame" by hand:
    //   magic FD 2F B5 28 (little-endian on disk)
    //   FHD  = 0x00 — Single_Segment_flag=0, no FCS, no Dictionary
    //   WD   = (exponent << 3) | mantissa
    //     exponent = 20 → windowLog = 30 (way > 23), mantissa = 0
    //   then enough garbage bytes for the parser to read.
    const frame = new Uint8Array(8)
    frame[0] = 0x28
    frame[1] = 0xb5
    frame[2] = 0x2f
    frame[3] = 0xfd
    frame[4] = 0x00 // FHD: SS=0, FCS=00, DID=000
    frame[5] = (20 << 3) | 0 // exponent=20 → windowLog 30
    // 6/7 are arbitrary
    const w = parseZstdFrameWindowLog(frame)
    expect(w).toBe(30)
  })
})

describe('zstdDecompress window-log enforcement (CQ-027)', () => {
  it('refuses a frame whose Window_Descriptor demands windowLog > 23', () => {
    const frame = new Uint8Array(8)
    frame[0] = 0x28
    frame[1] = 0xb5
    frame[2] = 0x2f
    frame[3] = 0xfd
    frame[4] = 0x00
    frame[5] = (20 << 3) | 0 // windowLog 30
    expect(() => zstdDecompress(frame)).toThrow(/windowLog 30/)
  })

  it('accepts frames within the canonical max', () => {
    const compressed = zstdCompress(enc.encode('payload'), { windowLog: ZSTD_MAX_WINDOW_LOG })
    const back = zstdDecompress(compressed)
    expect(new TextDecoder().decode(back)).toBe('payload')
  })
})
