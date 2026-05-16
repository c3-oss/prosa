import { z } from 'zod'
import { objectManifestEntrySchema } from './schemas.js'

export const OBJECT_PACK_BINARY_CONTENT_TYPE = 'application/vnd.prosa.object-pack.v1+binary'
export const OBJECT_PACK_BINARY_MAGIC = 'PROSAOP1'

const MAGIC_BYTES = new TextEncoder().encode(OBJECT_PACK_BINARY_MAGIC)
const HEADER_LENGTH_BYTES = 4
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

export const objectPackWireEntrySchema = objectManifestEntrySchema.and(
  z.object({
    offset: z.number().int().nonnegative(),
    length: z.number().int().nonnegative(),
  }),
)
export type ObjectPackWireEntry = z.infer<typeof objectPackWireEntrySchema>

export const objectPackBinaryHeaderSchema = z.object({
  entries: z.array(objectPackWireEntrySchema),
})
export type ObjectPackBinaryHeader = z.infer<typeof objectPackBinaryHeaderSchema>

export type BinaryObjectPack = ObjectPackBinaryHeader & {
  payload: Uint8Array
}

export type DecodeBinaryObjectPackOptions = {
  maxHeaderBytes?: number
}

export class BinaryObjectPackFormatError extends Error {
  override name = 'BinaryObjectPackFormatError'
}

function formatError(message: string): never {
  throw new BinaryObjectPackFormatError(message)
}

function assertMagic(bytes: Uint8Array): void {
  if (bytes.byteLength < MAGIC_BYTES.byteLength + HEADER_LENGTH_BYTES) {
    formatError('binary object pack is too short')
  }
  for (let index = 0; index < MAGIC_BYTES.byteLength; index += 1) {
    if (bytes[index] !== MAGIC_BYTES[index]) {
      formatError('binary object pack magic mismatch')
    }
  }
}

function headerLengthView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset + MAGIC_BYTES.byteLength, HEADER_LENGTH_BYTES)
}

export function encodeBinaryObjectPack(pack: BinaryObjectPack): Uint8Array {
  const headerBytes = textEncoder.encode(JSON.stringify({ entries: pack.entries }))
  if (headerBytes.byteLength > 0xffffffff) {
    formatError('binary object pack header is too large')
  }

  const headerOffset = MAGIC_BYTES.byteLength + HEADER_LENGTH_BYTES
  const payloadOffset = headerOffset + headerBytes.byteLength
  const out = new Uint8Array(payloadOffset + pack.payload.byteLength)
  out.set(MAGIC_BYTES, 0)
  new DataView(out.buffer, out.byteOffset + MAGIC_BYTES.byteLength, HEADER_LENGTH_BYTES).setUint32(
    0,
    headerBytes.byteLength,
  )
  out.set(headerBytes, headerOffset)
  out.set(pack.payload, payloadOffset)
  return out
}

export function decodeBinaryObjectPack(
  bytes: Uint8Array,
  options: DecodeBinaryObjectPackOptions = {},
): BinaryObjectPack {
  assertMagic(bytes)
  const headerLength = headerLengthView(bytes).getUint32(0)
  if (options.maxHeaderBytes != null && headerLength > options.maxHeaderBytes) {
    formatError('binary object pack header exceeds limit')
  }

  const headerOffset = MAGIC_BYTES.byteLength + HEADER_LENGTH_BYTES
  const payloadOffset = headerOffset + headerLength
  if (payloadOffset > bytes.byteLength) {
    formatError('binary object pack header exceeds body length')
  }

  let decoded: string
  try {
    decoded = textDecoder.decode(bytes.subarray(headerOffset, payloadOffset))
  } catch {
    formatError('binary object pack header is not valid UTF-8')
  }

  let header: unknown
  try {
    header = JSON.parse(decoded)
  } catch {
    formatError('binary object pack header is not valid JSON')
  }

  const parsed = objectPackBinaryHeaderSchema.safeParse(header)
  if (!parsed.success) {
    formatError('binary object pack header is invalid')
  }

  return {
    ...parsed.data,
    payload: bytes.subarray(payloadOffset),
  }
}
