import { describe, expect, it } from 'vitest'
import { blake3Hex, blake3HexAsync } from '../../src/core/cas/hash.js'

// RFC BLAKE3 test vectors from https://github.com/BLAKE3-team/BLAKE3/blob/master/test_vectors/test_vectors.json
const EMPTY_HASH = 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'
const ABC_HASH = '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85'

describe('blake3Hex compatibility vectors (sync, @noble/hashes)', () => {
  it('matches RFC test vector for empty input', () => {
    expect(blake3Hex(new Uint8Array())).toBe(EMPTY_HASH)
  })

  it("matches RFC test vector for 'abc'", () => {
    expect(blake3Hex(new TextEncoder().encode('abc'))).toBe(ABC_HASH)
  })
})

describe('blake3HexAsync compatibility vectors (async, hash-wasm WASM)', () => {
  it('matches RFC test vector for empty input', async () => {
    expect(await blake3HexAsync(new Uint8Array())).toBe(EMPTY_HASH)
  })

  it("matches RFC test vector for 'abc'", async () => {
    expect(await blake3HexAsync(new TextEncoder().encode('abc'))).toBe(ABC_HASH)
  })

  it('produces byte-identical output to blake3Hex for arbitrary input', async () => {
    const data = new TextEncoder().encode('the quick brown fox jumps over the lazy dog')
    expect(await blake3HexAsync(data)).toBe(blake3Hex(data))
  })
})
