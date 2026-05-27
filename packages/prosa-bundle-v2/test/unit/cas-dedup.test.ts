// Invariant I4: content-addressed dedup. The CAS pack format does not itself
// deduplicate within a single pack — that's a writer/shard-actor concern —
// but the object_id derived from BLAKE3 of uncompressed bytes is stable, so
// two sources producing identical bytes produce identical object_ids that
// the next layer can collapse.

import { describe, expect, it } from 'vitest'

import { buildCasPack, verifyCasPack } from '../../src/pack/cas-pack.js'

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

describe('CAS dedup (Invariant I4)', () => {
  it('two identical inputs across separate packs share the same object_id', () => {
    const a = buildCasPack([{ bytes: bytes('shared') }], { createdAt: '2025-01-02T03:04:05.123Z' })
    const b = buildCasPack([{ bytes: bytes('shared') }], { createdAt: '2025-01-02T03:04:05.456Z' })
    const ae = verifyCasPack(a.bytes).entries[0]
    const be = verifyCasPack(b.bytes).entries[0]
    expect(ae?.entry.object_id).toBe(be?.entry.object_id)
  })

  it('different inputs produce different object_ids', () => {
    const a = buildCasPack([{ bytes: bytes('foo') }], { createdAt: '2025-01-02T03:04:05.123Z' })
    const b = buildCasPack([{ bytes: bytes('bar') }], { createdAt: '2025-01-02T03:04:05.123Z' })
    const ae = verifyCasPack(a.bytes).entries[0]
    const be = verifyCasPack(b.bytes).entries[0]
    expect(ae?.entry.object_id).not.toBe(be?.entry.object_id)
  })

  it('object_id is BLAKE3 of UNCOMPRESSED bytes, independent of compression', () => {
    const data = bytes('compressible content '.repeat(50))
    const a = buildCasPack([{ bytes: data, compression: 'zstd' }], {
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    const b = buildCasPack([{ bytes: data, compression: 'none' }], {
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    const ae = verifyCasPack(a.bytes).entries[0]
    const be = verifyCasPack(b.bytes).entries[0]
    expect(ae?.entry.object_id).toBe(be?.entry.object_id)
    // But stored bytes (and stored_hash) differ.
    expect(ae?.entry.stored_hash).not.toBe(be?.entry.stored_hash)
  })
})
