import { describe, expect, it } from 'vitest'

import { canonicalCbor, canonicalTimestamp, toHex } from '../src/canonical.js'

describe('canonical CBOR encoding', () => {
  it('encodes null as 0xf6', () => {
    const bytes = canonicalCbor({ a: null }, ['a'])
    // 0x81 = array of length 1; 0xf6 = null
    expect(toHex(bytes)).toBe('81f6')
  })

  it('treats undefined and missing fields as null', () => {
    const bytes = canonicalCbor({ a: undefined }, ['a'])
    const bytesMissing = canonicalCbor({}, ['a'])
    expect(toHex(bytes)).toBe('81f6')
    expect(toHex(bytesMissing)).toBe('81f6')
  })

  it('encodes booleans as 0xf4/0xf5', () => {
    expect(toHex(canonicalCbor({ a: false, b: true }, ['a', 'b']))).toBe('82f4f5')
  })

  it('uses the smallest integer representation', () => {
    // Major type 0, argument inline (n < 24).
    expect(toHex(canonicalCbor({ a: 0 }, ['a']))).toBe('8100')
    expect(toHex(canonicalCbor({ a: 23 }, ['a']))).toBe('8117')
    // 1-byte argument (24..255).
    expect(toHex(canonicalCbor({ a: 24 }, ['a']))).toBe('811818')
    expect(toHex(canonicalCbor({ a: 255 }, ['a']))).toBe('8118ff')
    // 2-byte argument.
    expect(toHex(canonicalCbor({ a: 256 }, ['a']))).toBe('81190100')
    expect(toHex(canonicalCbor({ a: 65535 }, ['a']))).toBe('8119ffff')
    // 4-byte argument.
    expect(toHex(canonicalCbor({ a: 65536 }, ['a']))).toBe('811a00010000')
  })

  it('encodes negative integers with major type 1', () => {
    expect(toHex(canonicalCbor({ a: -1 }, ['a']))).toBe('8120')
    expect(toHex(canonicalCbor({ a: -10 }, ['a']))).toBe('8129')
    expect(toHex(canonicalCbor({ a: -100 }, ['a']))).toBe('813863')
    expect(toHex(canonicalCbor({ a: -256 }, ['a']))).toBe('8138ff')
    expect(toHex(canonicalCbor({ a: -257 }, ['a']))).toBe('81390100')
  })

  it('rejects non-integer numbers', () => {
    expect(() => canonicalCbor({ a: 1.5 }, ['a'])).toThrow(/safe integers/)
    expect(() => canonicalCbor({ a: Number.NaN }, ['a'])).toThrow(/safe integers/)
    expect(() => canonicalCbor({ a: Number.POSITIVE_INFINITY }, ['a'])).toThrow(/safe integers/)
  })

  it('rejects unsafe-integer numbers and accepts bigint instead', () => {
    expect(() => canonicalCbor({ a: 2 ** 53 }, ['a'])).toThrow(/bigint/)
    // bigint encoded as 8-byte argument when above 2^32.
    const out = canonicalCbor({ a: 0xffffffff_ffffffffn }, ['a'])
    expect(toHex(out)).toBe('811bffffffffffffffff')
  })

  it('NFC-normalizes strings before encoding', () => {
    // 'é' in NFD form (e + combining acute) vs NFC form (precomposed).
    const nfd = 'é'
    const nfc = 'é'
    const bytesNfd = canonicalCbor({ a: nfd }, ['a'])
    const bytesNfc = canonicalCbor({ a: nfc }, ['a'])
    expect(toHex(bytesNfd)).toBe(toHex(bytesNfc))
    // Single byte length prefix (2 utf8 bytes) followed by 0xc3 0xa9.
    expect(toHex(bytesNfc)).toBe('8162c3a9')
  })

  it('encodes the empty string', () => {
    expect(toHex(canonicalCbor({ a: '' }, ['a']))).toBe('8160')
  })

  it('respects field order, not object key insertion order', () => {
    const out = canonicalCbor({ b: 'x', a: 1 }, ['a', 'b'])
    // [1, "x"] = 82 01 61 78
    expect(toHex(out)).toBe('820161 78'.replaceAll(' ', ''))
  })

  it('throws when field order is omitted for object inputs', () => {
    expect(() => canonicalCbor({ a: 1 } as unknown as Record<string, never>)).toThrow(/fieldOrder/)
  })

  it('accepts a pre-ordered tuple without a fieldOrder', () => {
    expect(toHex(canonicalCbor([1, null, true] as const))).toBe('83 01 f6 f5'.replaceAll(' ', ''))
  })
})

describe('canonicalTimestamp', () => {
  it('passes through canonical ms-precision UTC', () => {
    expect(canonicalTimestamp('2025-01-02T03:04:05.123Z')).toBe('2025-01-02T03:04:05.123Z')
  })

  it('emits .000Z for timestamps with no fractional part', () => {
    expect(canonicalTimestamp('2025-01-02T03:04:05Z')).toBe('2025-01-02T03:04:05.000Z')
  })

  it('truncates (not rounds) sub-millisecond precision toward the epoch', () => {
    expect(canonicalTimestamp('2025-01-02T03:04:05.999999Z')).toBe('2025-01-02T03:04:05.999Z')
    expect(canonicalTimestamp('2025-01-02T03:04:05.999500Z')).toBe('2025-01-02T03:04:05.999Z')
    // 1-digit fractional must be left-padded.
    expect(canonicalTimestamp('2025-01-02T03:04:05.1Z')).toBe('2025-01-02T03:04:05.100Z')
  })

  it('converts non-UTC offsets to UTC', () => {
    expect(canonicalTimestamp('2025-01-02T03:04:05+02:00')).toBe('2025-01-02T01:04:05.000Z')
    expect(canonicalTimestamp('2025-01-02T03:04:05.123-05:30')).toBe('2025-01-02T08:34:05.123Z')
  })

  it('rejects non-RFC3339 input', () => {
    expect(() => canonicalTimestamp('not-a-timestamp')).toThrow(/RFC3339/)
  })
})
