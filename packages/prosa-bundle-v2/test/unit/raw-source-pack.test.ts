import { describe, expect, it } from 'vitest'

import { decodePackFrame } from '../../src/pack/framing.js'
import {
  RAW_SRC_PACK_MAGIC,
  RawSourcePackVerifyError,
  buildRawSourcePack,
  recoverSourceFile,
  verifyRawSourcePack,
} from '../../src/pack/raw-source-pack.js'

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

const created = '2025-01-02T03:04:05.123Z'

describe('raw source pack (build/verify)', () => {
  it('round-trips entries and validates raw_source_root against canonical recomputation', () => {
    const built = buildRawSourcePack(
      [
        {
          source_file_id: 'src_b',
          source_tool: 'codex',
          path: '/repo/b.jsonl',
          file_kind: 'session_jsonl',
          mtime_ns: null,
          bytes: bytes('beta content'),
        },
        {
          source_file_id: 'src_a',
          source_tool: 'codex',
          path: '/repo/a.jsonl',
          file_kind: 'session_jsonl',
          mtime_ns: null,
          bytes: bytes('alpha content'),
        },
      ],
      { createdAt: created },
    )
    const v = verifyRawSourcePack(built.bytes)
    expect(v.entries.length).toBe(2)
    // Sorted ASC by source_file_id.
    expect(v.entries.map((e) => e.entry.source_file_id)).toEqual(['src_a', 'src_b'])
    // Frame carries the right magic.
    const frame = decodePackFrame(built.bytes)
    expect(frame.magic).toBe(RAW_SRC_PACK_MAGIC)
    // raw_source_root in the header matches the canonical recomputation
    // performed inside verifyRawSourcePack (no error means they matched).
    expect(v.header.raw_source_root).toMatch(/^[0-9a-f]{64}$/)
  })

  it('preserves source bytes exactly (Invariant I1: raw preservation)', () => {
    const original = bytes('original file content — the raw layer must preserve every byte exactly')
    const built = buildRawSourcePack(
      [
        {
          source_file_id: 'src_x',
          source_tool: 'hermes',
          path: '/tmp/x.bin',
          file_kind: 'session_protobuf',
          mtime_ns: null,
          bytes: original,
        },
      ],
      { createdAt: created },
    )
    const recovered = recoverSourceFile(built.bytes, 'src_x')
    expect(recovered.uncompressed.length).toBe(original.length)
    for (let i = 0; i < original.length; i++) {
      expect(recovered.uncompressed[i]).toBe(original[i])
    }
  })

  it('rejects a substituted entry (tampered stored_hash)', () => {
    const built = buildRawSourcePack(
      [
        {
          source_file_id: 'src_a',
          source_tool: 'codex',
          path: '/x',
          file_kind: 'session_jsonl',
          mtime_ns: null,
          bytes: bytes('original'),
        },
      ],
      { createdAt: created },
    )
    const tampered = new Uint8Array(built.bytes)
    const view = new DataView(tampered.buffer, tampered.byteOffset, tampered.byteLength)
    const headerLen = view.getUint32(20, true)
    const payloadStart = 56 + headerLen
    if (payloadStart < tampered.length) {
      tampered[payloadStart] = (tampered[payloadStart] as number) ^ 0xaa
    }
    expect(() => verifyRawSourcePack(tampered)).toThrow(RawSourcePackVerifyError)
  })

  it('rejects an unknown source_file_id during recovery', () => {
    const built = buildRawSourcePack(
      [
        {
          source_file_id: 'src_a',
          source_tool: 'codex',
          path: '/x',
          file_kind: 'session_jsonl',
          mtime_ns: null,
          bytes: bytes('content'),
        },
      ],
      { createdAt: created },
    )
    expect(() => recoverSourceFile(built.bytes, 'src_missing')).toThrow(/not found/)
  })

  it('is idempotent: same inputs produce identical pack bytes', () => {
    const inputs = [
      {
        source_file_id: 'src_a',
        source_tool: 'codex' as const,
        path: '/x',
        file_kind: 'session_jsonl',
        mtime_ns: null,
        bytes: bytes('payload'),
      },
    ]
    const a = buildRawSourcePack(inputs, { createdAt: created })
    const b = buildRawSourcePack(inputs, { createdAt: created })
    expect(a.packDigest).toBe(b.packDigest)
    expect(a.bytes.length).toBe(b.bytes.length)
    for (let i = 0; i < a.bytes.length; i++) {
      expect(a.bytes[i]).toBe(b.bytes[i])
    }
  })
})
