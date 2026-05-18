import { blake3 } from '@noble/hashes/blake3'
import { describe, expect, it } from 'vitest'

import { crossEntityRoot, merkleRoot, merkleSubroot, toHex } from '../src/canonical.js'

function leaf(label: string): Uint8Array {
  return blake3(new TextEncoder().encode(label))
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

describe('merkleRoot', () => {
  it('returns 32 zero bytes for an empty input', () => {
    const root = merkleRoot([])
    expect(root.length).toBe(32)
    expect(toHex(root)).toBe('00'.repeat(32))
  })

  it('returns the single leaf unchanged when only one is supplied', () => {
    const l = leaf('only')
    const root = merkleRoot([l])
    expect(toHex(root)).toBe(toHex(l))
  })

  it('hashes left||right for two leaves', () => {
    const a = leaf('a')
    const b = leaf('b')
    const expected = blake3(concat(a, b))
    expect(toHex(merkleRoot([a, b]))).toBe(toHex(expected))
  })

  it('duplicates the last leaf when odd at any level', () => {
    const a = leaf('a')
    const b = leaf('b')
    const c = leaf('c')
    // Level 1: pair (a,b) and (c,c)
    const pair0 = blake3(concat(a, b))
    const pair1 = blake3(concat(c, c))
    // Level 2: pair them.
    const expected = blake3(concat(pair0, pair1))
    expect(toHex(merkleRoot([a, b, c]))).toBe(toHex(expected))
  })

  it('rejects non-32-byte leaves', () => {
    expect(() => merkleRoot([new Uint8Array(31)])).toThrow(/32 bytes/)
  })
})

describe('merkleSubroot', () => {
  it('returns 32 zero bytes for an entity type with no rows', () => {
    expect(toHex(merkleSubroot('session', []))).toBe('00'.repeat(32))
  })

  it('is stable under input row reordering (sorts by primary key)', () => {
    const rows = [
      {
        project_id: 'b',
        canonical_path: null,
        path_hash: null,
        source_tool: null,
        source_project_id: null,
        display_name: null,
        created_at: '2025-01-02T03:04:05.000Z',
      },
      {
        project_id: 'a',
        canonical_path: null,
        path_hash: null,
        source_tool: null,
        source_project_id: null,
        display_name: null,
        created_at: '2025-01-02T03:04:05.000Z',
      },
    ]
    const ordered = [rows[1], rows[0]] as typeof rows
    expect(toHex(merkleSubroot('project', rows))).toBe(toHex(merkleSubroot('project', ordered)))
  })
})

describe('crossEntityRoot', () => {
  it('treats missing entity types as 32 zero-byte subroots', () => {
    // With every entity missing, the cross-entity root is merkleRoot of 13
    // zero-byte subroots.
    const root = crossEntityRoot({})
    // Compute the same with explicit zero subroots.
    const zeros = Array.from({ length: 13 }, () => new Uint8Array(32))
    expect(toHex(root)).toBe(toHex(merkleRoot(zeros)))
  })

  it('differs when one entity-type subroot is non-zero', () => {
    const a = crossEntityRoot({})
    const b = crossEntityRoot({ session: blake3(new TextEncoder().encode('x')) })
    expect(toHex(a)).not.toBe(toHex(b))
  })
})
