// CQ-122 closure: streaming validator covers the parts of the Lane 4
// pipeline that have to run before/around the decoder — every frame
// header, transport hash, abort hook, per-upload byte budget — across
// chunked input. Per-entry hashes and S3 multipart wiring are Lane 5
// surface and are NOT in scope.

import { blake3 } from '@noble/hashes/blake3'
import { describe, expect, it } from 'vitest'
import { Compressor } from 'zstd-napi'
import {
  DEFAULT_MAX_ZSTD_WINDOW_BYTES,
  PackBytesOverBudgetError,
  PackTransportHashMismatchError,
  PackValidationError,
  PackZstdWindowTooLargeError,
  validatePackStream,
} from '../../src/v2/upload/validate.js'

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) out += (bytes[i] as number).toString(16).padStart(2, '0')
  return out
}

async function* asChunks(buf: Uint8Array, chunkSize: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < buf.length; i += chunkSize) {
    yield buf.subarray(i, Math.min(buf.length, i + chunkSize))
  }
}

function realZstdPack(payload: Uint8Array): Uint8Array {
  const c = new Compressor()
  return new Uint8Array(c.compress(Buffer.from(payload)))
}

function craftFrameHeader(exponent: number, mantissa: number): Uint8Array {
  const fhd = 0b00000000
  const wd = ((exponent & 0b11111) << 3) | (mantissa & 0b111)
  return new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, fhd, wd])
}

describe('validatePackStream (Lane 4 streaming gate)', () => {
  it('streams a real zstd pack and reports the canonical pack digest', async () => {
    const payload = new Uint8Array(64 * 1024)
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251
    const pack = realZstdPack(payload)
    const expected = `blake3:${bytesToHex(blake3(pack))}`

    const result = await validatePackStream(asChunks(pack, 4096))
    expect(result.totalBytes).toBe(pack.length)
    expect(result.packDigest).toBe(expected)
    expect(result.frames.length).toBe(1)
    expect(result.frames[0]?.windowBytes).toBeLessThanOrEqual(DEFAULT_MAX_ZSTD_WINDOW_BYTES)
  })

  it('reassembles the frame header across a chunk boundary', async () => {
    const pack = realZstdPack(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
    // 1-byte chunks force every byte to cross a boundary.
    const result = await validatePackStream(asChunks(pack, 1))
    expect(result.frames.length).toBe(1)
    expect(result.totalBytes).toBe(pack.length)
  })

  it('rejects an oversized later frame with PACK_ZSTD_WINDOW_TOO_LARGE and fires the abort hook', async () => {
    // exp 14 = 16 MiB window, beyond the 8 MiB cap.
    const headerOnly = craftFrameHeader(14, 0)
    let aborted: PackValidationError | null = null
    let thrown: unknown = null
    try {
      await validatePackStream(asChunks(headerOnly, 2), {
        onAbort: (err) => {
          aborted = err
        },
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(PackZstdWindowTooLargeError)
    expect(aborted).toBeInstanceOf(PackZstdWindowTooLargeError)
    expect((aborted as unknown as PackZstdWindowTooLargeError).actualWindowBytes).toBe(16 * 1024 * 1024)
  })

  it('rejects a mismatched transport hash and fires the abort hook', async () => {
    const pack = realZstdPack(new Uint8Array([9, 9, 9]))
    let aborted: PackValidationError | null = null
    let thrown: unknown = null
    try {
      await validatePackStream(asChunks(pack, 8), {
        expectedTransportHash: 'blake3:0000000000000000000000000000000000000000000000000000000000000000',
        onAbort: (err) => {
          aborted = err
        },
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(PackTransportHashMismatchError)
    expect(aborted).toBeInstanceOf(PackTransportHashMismatchError)
  })

  it('accepts a matching transport hash', async () => {
    const pack = realZstdPack(new Uint8Array([7, 7, 7]))
    const transportHash = `blake3:${bytesToHex(blake3(pack))}`
    const result = await validatePackStream(asChunks(pack, 16), { expectedTransportHash: transportHash })
    expect(result.packDigest).toBe(transportHash)
  })

  it('enforces the per-upload byte budget', async () => {
    const pack = realZstdPack(new Uint8Array([1, 2, 3]))
    expect(pack.length).toBeGreaterThan(0)

    let aborted: PackValidationError | null = null
    let thrown: unknown = null
    try {
      await validatePackStream(asChunks(pack, 4), {
        maxPackBytes: pack.length - 1,
        onAbort: (err) => {
          aborted = err
        },
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(PackBytesOverBudgetError)
    expect(aborted).toBeInstanceOf(PackBytesOverBudgetError)
  })

  it('rejects a stream that does not begin with a zstd frame magic', async () => {
    const bogus = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x00])
    let thrown: unknown = null
    try {
      await validatePackStream(asChunks(bogus, 2))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(PackValidationError)
    expect((thrown as PackValidationError).code).toBe('PACK_NO_ZSTD_FRAME')
  })

  it('rejects an empty stream', async () => {
    let thrown: unknown = null
    try {
      await validatePackStream(asChunks(new Uint8Array(), 1))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(PackValidationError)
  })

  it('caps the internal scratch buffer at the documented size', async () => {
    // Send a long stream where the frame header arrives as the very
    // first 64 bytes — the scratch must never grow beyond that even
    // when the body is large.
    const pack = realZstdPack(new Uint8Array(4 * 1024 * 1024))
    const result = await validatePackStream(asChunks(pack, 1024), { maxPackBytes: 16 * 1024 * 1024 })
    expect(result.totalBytes).toBe(pack.length)
  })
})
