import { describe, expect, it } from 'vitest'

import { canonicalJson, canonicalJsonString, sanitizeJsonString } from '../../src/pack/framing.js'

describe('sanitizeJsonString', () => {
  it('leaves plain ASCII unchanged', () => {
    const s = 'hello world'
    expect(sanitizeJsonString(s)).toBe(s)
  })

  it('preserves valid UTF-16 surrogate pairs (emoji)', () => {
    const s = 'pile 💩 of poo'
    expect(sanitizeJsonString(s)).toBe(s)
  })

  it('replaces a lone high surrogate with U+FFFD', () => {
    // 0xD83D without its low half. String.fromCharCode emits the lone unit.
    const lone = String.fromCharCode(0xd83d)
    expect(sanitizeJsonString(`a${lone}b`)).toBe('a�b')
  })

  it('replaces a lone low surrogate with U+FFFD', () => {
    const lone = String.fromCharCode(0xdc00)
    expect(sanitizeJsonString(`x${lone}y`)).toBe('x�y')
  })

  it('replaces a high surrogate followed by a non-surrogate', () => {
    const lone = String.fromCharCode(0xd83d)
    expect(sanitizeJsonString(`${lone}A`)).toBe('�A')
  })

  it('handles a trailing lone high surrogate at the end of the string', () => {
    const lone = String.fromCharCode(0xd83d)
    expect(sanitizeJsonString(`tail${lone}`)).toBe('tail�')
  })

  it('is idempotent', () => {
    const lone = String.fromCharCode(0xd83d)
    const once = sanitizeJsonString(`mix ${lone} pair 💩`)
    expect(sanitizeJsonString(once)).toBe(once)
  })
})

describe('canonicalJsonString with surrogate sanitization', () => {
  it('produces parseable JSON even when input strings carry lone surrogates', () => {
    const lone = String.fromCharCode(0xd83d)
    const out = canonicalJsonString({ text: `before${lone}after` })
    // No throw — output is RFC 8259-conformant.
    const parsed = JSON.parse(out) as { text: string }
    expect(parsed.text).toBe('before�after')
  })

  it('sanitizes lone surrogates in object keys', () => {
    const lone = String.fromCharCode(0xdc00)
    const out = canonicalJsonString({ [`k${lone}`]: 1 })
    const parsed = JSON.parse(out) as Record<string, number>
    expect(Object.keys(parsed)).toEqual(['k�'])
  })

  it('keeps valid surrogate pairs as escaped code units in output', () => {
    // JSON.stringify escapes non-ASCII to \uXXXX, so the pair survives as
    // two adjacent escapes — parseable, decodable, identical round-trip.
    const out = canonicalJsonString('💩')
    expect(JSON.parse(out)).toBe('💩')
  })

  it('canonicalJson over sanitized bytes is byte-deterministic', () => {
    const lone = String.fromCharCode(0xd83d)
    const a = canonicalJson({ t: `x${lone}y` })
    const b = canonicalJson({ t: `x${lone}y` })
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })
})
