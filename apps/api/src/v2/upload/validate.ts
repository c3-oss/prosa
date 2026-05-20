// Bounded zstd window enforcement for v2 pack uploads.
//
// Production validation is multi-stage (pack-level BLAKE3, per-slice
// BLAKE3, streaming decode, S3 multipart upload). Lane 4 ships the
// window-cap check that gates streaming decompression — the part with
// teeth in terms of denial-of-service. The rest of the pipeline is
// wired in Lane 5 with the live promotion protocol.
//
// The zstd Frame_Header layout is parsed directly. We do not run the
// decoder to compute the window — that would let an attacker burn
// memory before we reject. The window is recovered from the
// Window_Descriptor byte (or the Frame_Content_Size when
// Single_Segment_flag is set) and compared against the budget.
//
// References:
// - RFC 8478 §3.1 (Zstandard Frame_Header).

export const ZSTD_MAGIC = 0xfd2fb528
export const DEFAULT_MAX_ZSTD_WINDOW_BYTES = 8 * 1024 * 1024

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
 * than the configured cap. The check runs on the first ~32 bytes only;
 * no decompression is performed.
 */
export function validateZstdWindow(headBytes: Uint8Array, opts: ValidateZstdWindowOptions = {}): ZstdFrameSummary {
  const max = opts.maxWindowBytes ?? DEFAULT_MAX_ZSTD_WINDOW_BYTES
  const summary = parseZstdFrameHeader(headBytes)
  if (summary.windowBytes > max) {
    throw new PackZstdWindowTooLargeError(max, summary.windowBytes)
  }
  return summary
}
