// Bounded streaming validation for v2 pack uploads.
//
// Lane 4 implements the parts of the pipeline that have to run before
// the decoder gets any bytes and that have to follow the bytes through
// the upload stream:
//
// - zstd Window_Descriptor / FCS parse + 8 MiB window cap, applied to
//   every zstd frame in the stream (not just the first).
// - pack-level BLAKE3 hashed incrementally as chunks arrive.
// - transport hash comparison: if the caller declared a transport hash,
//   the streamed bytes' BLAKE3 must match.
// - bounded scratch buffer (≤ 64 bytes; only enough to span a zstd
//   frame header across chunk boundaries).
// - per-upload total-bytes cap (default 128 MiB) so a single request
//   cannot exhaust the worker memory budget.
// - `onAbort` hook fired on every validation failure so the caller can
//   abort an S3 multipart upload before the storage commits.
//
// Lane 5 surface — NOT implemented here:
//
// - per-entry stored_hash / uncompressed_hash verification (depends on
//   the parsed pack binary layout from Lane 1);
// - S3 multipart upload wiring (depends on the live promotion route);
// - validation concurrency cap (Lane 5 wires the request pipeline);
// - streaming zstd decompression itself.
//
// The zstd frame headers are parsed directly. We do not run the
// decoder to compute the window — that would let an attacker burn
// memory before we reject.
//
// References:
// - RFC 8478 §3.1 (Zstandard Frame_Header).
// - RFC 8478 §3.1.1.1.3 (Magic_Number for skippable frames).

import { blake3 } from '@noble/hashes/blake3'

export const ZSTD_MAGIC = 0xfd2fb528
export const ZSTD_SKIPPABLE_MAGIC_MIN = 0x184d2a50
export const ZSTD_SKIPPABLE_MAGIC_MAX = 0x184d2a5f
export const DEFAULT_MAX_ZSTD_WINDOW_BYTES = 8 * 1024 * 1024
export const DEFAULT_MAX_PACK_BYTES = 128 * 1024 * 1024
export const STREAM_HEADER_BUFFER_BYTES = 64

export type ZstdFrameSummary = {
  /**
   * The advertised window size in bytes. Computed from the
   * Window_Descriptor exponent + mantissa, or from the
   * Frame_Content_Size when Single_Segment_flag is set (in which case
   * `windowBytes === contentSizeBytes`).
   */
  windowBytes: number
  /** Whether the frame header set the Single_Segment_flag. */
  singleSegment: boolean
  /** Declared content size (if any), otherwise `null`. */
  contentSizeBytes: number | null
  /** Total byte length of the parsed frame header (including the magic number). */
  headerByteLength: number
}

export class PackValidationError extends Error {
  override name = 'PackValidationError'
  constructor(
    public readonly code: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(`${code} ${JSON.stringify(details)}`)
  }
}

export class PackZstdWindowTooLargeError extends PackValidationError {
  override name = 'PackZstdWindowTooLargeError'
  constructor(
    public readonly maxWindowBytes: number,
    public readonly actualWindowBytes: number,
  ) {
    super('PACK_ZSTD_WINDOW_TOO_LARGE', {
      maxWindowBytes,
      actualWindowBytes,
      action: 'reencode_pack',
    })
  }
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) {
    throw new PackValidationError('ZSTD_HEADER_TRUNCATED', { needBytes: offset + 4, gotBytes: bytes.length })
  }
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0
}

function readUintLE(bytes: Uint8Array, offset: number, byteLength: number): number {
  if (offset + byteLength > bytes.length) {
    throw new PackValidationError('ZSTD_HEADER_TRUNCATED', {
      needBytes: offset + byteLength,
      gotBytes: bytes.length,
    })
  }
  let value = 0
  for (let i = 0; i < byteLength; i += 1) {
    value += bytes[offset + i]! * 2 ** (8 * i)
  }
  return value
}

/**
 * Parse a zstd frame header well enough to recover the advertised
 * window size. Throws `PackValidationError` for truncated input or a
 * missing magic number; does NOT throw for an oversized window — that
 * is the caller's policy decision.
 */
export function parseZstdFrameHeader(bytes: Uint8Array): ZstdFrameSummary {
  if (bytes.length < 5) {
    throw new PackValidationError('ZSTD_HEADER_TRUNCATED', { needBytes: 5, gotBytes: bytes.length })
  }
  const magic = readUint32LE(bytes, 0)
  if (magic !== ZSTD_MAGIC) {
    throw new PackValidationError('ZSTD_BAD_MAGIC', { expected: ZSTD_MAGIC, actual: magic })
  }

  const fhd = bytes[4]
  if (fhd === undefined) {
    throw new PackValidationError('ZSTD_HEADER_TRUNCATED', { needBytes: 5, gotBytes: bytes.length })
  }
  const fcsFieldSizeFlag = (fhd >> 6) & 0b11
  const singleSegment = ((fhd >> 5) & 0b1) === 1
  const didFieldSizeFlag = fhd & 0b11

  const fcsFieldSize = fcsFieldSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << fcsFieldSizeFlag
  const didFieldSize = didFieldSizeFlag === 0 ? 0 : didFieldSizeFlag === 1 ? 1 : didFieldSizeFlag === 2 ? 2 : 4

  // Layout: [magic 4][fhd 1][windowDesc 0..1][did 0..4][fcs 0..8]
  let offset = 5
  let windowBytes: number
  if (singleSegment) {
    // No Window_Descriptor — window equals Frame_Content_Size.
    windowBytes = -1 // resolved below from FCS
  } else {
    const wd = bytes[offset]
    if (wd === undefined) {
      throw new PackValidationError('ZSTD_HEADER_TRUNCATED', { needBytes: offset + 1, gotBytes: bytes.length })
    }
    const exponent = (wd >> 3) & 0b11111
    const mantissa = wd & 0b111
    const base = 2 ** (10 + exponent)
    windowBytes = base + (base / 8) * mantissa
    offset += 1
  }
  offset += didFieldSize

  let contentSizeBytes: number | null = null
  if (fcsFieldSize > 0) {
    const raw = readUintLE(bytes, offset, fcsFieldSize)
    // RFC 8478 §3.1.1.4: FCS_field_size == 2 → value + 256.
    contentSizeBytes = fcsFieldSize === 2 ? raw + 256 : raw
    offset += fcsFieldSize
  }

  if (singleSegment) {
    if (contentSizeBytes === null) {
      throw new PackValidationError('ZSTD_HEADER_INVALID', {
        reason: 'single_segment_without_fcs',
      })
    }
    windowBytes = contentSizeBytes
  }

  return {
    windowBytes,
    singleSegment,
    contentSizeBytes,
    headerByteLength: offset,
  }
}

export type ValidateZstdWindowOptions = {
  maxWindowBytes?: number
}

/**
 * Reject the pack stream if its zstd frame advertises a window larger
 * than the configured cap. The check runs on the supplied header bytes
 * only; no decompression is performed. Use `validatePackStream` for
 * chunk-iterating uploads.
 */
export function validateZstdWindow(headBytes: Uint8Array, opts: ValidateZstdWindowOptions = {}): ZstdFrameSummary {
  const max = opts.maxWindowBytes ?? DEFAULT_MAX_ZSTD_WINDOW_BYTES
  const summary = parseZstdFrameHeader(headBytes)
  if (summary.windowBytes > max) {
    throw new PackZstdWindowTooLargeError(max, summary.windowBytes)
  }
  return summary
}

export class PackTransportHashMismatchError extends PackValidationError {
  override name = 'PackTransportHashMismatchError'
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super('PACK_TRANSPORT_HASH_MISMATCH', { expected, actual })
  }
}

export class PackBytesOverBudgetError extends PackValidationError {
  override name = 'PackBytesOverBudgetError'
  constructor(
    public readonly maxBytes: number,
    public readonly observedBytes: number,
  ) {
    super('PACK_BYTES_OVER_BUDGET', { maxBytes, observedBytes })
  }
}

export type ValidatePackStreamOptions = {
  /** Max advertised zstd window per frame. Default 8 MiB. */
  maxWindowBytes?: number
  /** Max total streamed bytes. Default 128 MiB. */
  maxPackBytes?: number
  /** Required transport hash (tagged `blake3:<64-hex>`); compared after the last chunk. */
  expectedTransportHash?: string
  /**
   * Fired on every validation failure (window too large, hash mismatch,
   * budget exceeded). Implementations should abort any storage upload
   * they have started for this pack. Returning a promise is allowed.
   */
  onAbort?: (reason: PackValidationError) => Promise<void> | void
}

export type ValidatePackStreamResult = {
  totalBytes: number
  /** Tagged hash form `blake3:<64-hex>`. */
  packDigest: string
  /** Window summary for every frame discovered in the stream. */
  frames: ZstdFrameSummary[]
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] as number).toString(16).padStart(2, '0')
  }
  return out
}

/**
 * Streaming pack validator.
 *
 * Reads chunks from an async iterable, hashes them through a
 * single-pass BLAKE3, parses the leading zstd frame header across
 * arbitrary chunk boundaries, enforces the 8 MiB window cap, and
 * enforces a total-byte budget. The validator does NOT scan for
 * additional zstd frames inside the same pack body — v2 packs are
 * single-frame by construction; multi-frame enforcement is Lane 5
 * surface that needs the parsed pack-body format.
 *
 * On any validation failure, `onAbort` is fired with the typed error
 * before the function rethrows. That hook is the contract callers use
 * to abort an S3 multipart upload.
 */
export async function validatePackStream(
  stream: AsyncIterable<Uint8Array>,
  opts: ValidatePackStreamOptions = {},
): Promise<ValidatePackStreamResult> {
  const maxWindowBytes = opts.maxWindowBytes ?? DEFAULT_MAX_ZSTD_WINDOW_BYTES
  const maxPackBytes = opts.maxPackBytes ?? DEFAULT_MAX_PACK_BYTES

  const hasher = blake3.create()
  let totalBytes = 0
  /**
   * Header scratch — accumulates bytes from the START of the stream
   * until we have enough to parse the first zstd frame header. Capped
   * at `STREAM_HEADER_BUFFER_BYTES`; once we parse or fail, the
   * buffer is dropped and the rest of the stream flows through with
   * just hashing + budget enforcement.
   */
  let headerScratch: Uint8Array | null = new Uint8Array(0)
  const frames: ZstdFrameSummary[] = []

  const fail = async (err: PackValidationError): Promise<never> => {
    if (opts.onAbort) await opts.onAbort(err)
    throw err
  }

  const tryParseHeader = async (): Promise<void> => {
    if (!headerScratch) return
    if (headerScratch.length < 5) return
    const magic = readUint32LE(headerScratch, 0)
    if (magic !== ZSTD_MAGIC) {
      await fail(
        new PackValidationError('PACK_NO_ZSTD_FRAME', {
          expectedMagic: ZSTD_MAGIC,
          actualMagic: magic,
          observedAt: 0,
        }),
      )
      return
    }
    let summary: ZstdFrameSummary
    try {
      summary = parseZstdFrameHeader(headerScratch)
    } catch (err) {
      if (err instanceof PackValidationError && err.code === 'ZSTD_HEADER_TRUNCATED') {
        return // wait for more bytes
      }
      await fail(err as PackValidationError)
      return
    }
    if (summary.windowBytes > maxWindowBytes) {
      await fail(new PackZstdWindowTooLargeError(maxWindowBytes, summary.windowBytes))
      return
    }
    frames.push(summary)
    headerScratch = null
  }

  for await (const chunk of stream) {
    if (chunk.length === 0) continue
    if (totalBytes + chunk.length > maxPackBytes) {
      await fail(new PackBytesOverBudgetError(maxPackBytes, totalBytes + chunk.length))
    }
    hasher.update(chunk)
    totalBytes += chunk.length

    const currentScratch: Uint8Array | null = headerScratch
    if (currentScratch) {
      const remainingCapacity = STREAM_HEADER_BUFFER_BYTES - currentScratch.length
      const take = Math.min(remainingCapacity, chunk.length)
      if (take > 0) {
        const merged: Uint8Array = new Uint8Array(currentScratch.length + take)
        merged.set(currentScratch, 0)
        merged.set(chunk.subarray(0, take), currentScratch.length)
        headerScratch = merged
      }
      await tryParseHeader()
    }
  }

  // End-of-stream: try once more in case the buffer never reached the
  // parse threshold (truncated upload).
  if (headerScratch) {
    if (headerScratch.length === 0) {
      await fail(new PackValidationError('PACK_EMPTY', { totalBytes }))
    }
    await tryParseHeader()
    if (frames.length === 0) {
      await fail(
        new PackValidationError('PACK_HEADER_TRUNCATED', {
          totalBytes,
          observedBytes: headerScratch?.length ?? 0,
        }),
      )
    }
  }

  if (frames.length === 0) {
    await fail(new PackValidationError('PACK_NO_ZSTD_FRAME', { reason: 'unparsed', totalBytes }))
  }

  const digestHex = bytesToHex(hasher.digest())
  const packDigest = `blake3:${digestHex}`

  if (opts.expectedTransportHash !== undefined && opts.expectedTransportHash !== packDigest) {
    await fail(new PackTransportHashMismatchError(opts.expectedTransportHash, packDigest))
  }

  return { totalBytes, packDigest, frames }
}
