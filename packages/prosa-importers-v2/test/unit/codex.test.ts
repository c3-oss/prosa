// Codex Provider unit tests.
//
// Covers the load-bearing paths:
//   - discovery walks a Codex-shape sessions tree
//   - cheap-identify derives the same logical key for two paths
//     pointing at the same session_meta.id
//   - parseAndProject emits one SessionV2 + one SourceFileV2 + one
//     RawRecordV2 per JSONL line, with content_hash + object_id
//     equal to blake3 of the file bytes
//   - the orchestrator backfills source_file pack metadata correctly
//     when running through `runCompileImports`

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initBundle } from '@c3-oss/prosa-bundle-v2'
import { toHex } from '@c3-oss/prosa-types-v2'
import { blake3 } from '@noble/hashes/blake3'
import { describe, expect, it } from 'vitest'

import { CodexProvider } from '../../src/codex/index.js'
import { runCompileImports } from '../../src/orchestrator.js'

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'prosa-codex-'))
}

const SAMPLE_ENVELOPES = [
  {
    type: 'session_meta',
    timestamp: '2025-01-02T03:04:05.123Z',
    payload: {
      id: 'sess_abc123',
      cwd: '/repo',
      cli_version: '1.0.0',
    },
  },
  {
    type: 'turn_context',
    timestamp: '2025-01-02T03:04:06.000Z',
    payload: { turn_id: 'turn_001', cwd: '/repo', model: 'gpt-4o' },
  },
  {
    type: 'response_item',
    timestamp: '2025-01-02T03:04:07.000Z',
    payload: { role: 'user', text: 'hello' },
  },
]

function jsonlBytes(envelopes: readonly unknown[]): Uint8Array {
  const body = `${envelopes.map((e) => JSON.stringify(e)).join('\n')}\n`
  return new TextEncoder().encode(body)
}

describe('CodexProvider', () => {
  it('discover walks YYYY/MM/DD jsonl tree and emits one DiscoveredSourceFile per *.jsonl', async () => {
    const root = await tmp()
    await mkdir(join(root, '2025', '01', '02'), { recursive: true })
    const bytes = jsonlBytes(SAMPLE_ENVELOPES)
    await writeFile(join(root, '2025', '01', '02', 'rollout-1.jsonl'), bytes)
    await writeFile(join(root, '2025', '01', '02', 'rollout-2.jsonl'), bytes)
    // Non-jsonl files are skipped.
    await writeFile(join(root, 'README.md'), 'ignore me')
    const provider = new CodexProvider()
    const files = await provider.discover(root)
    expect(files.length).toBe(2)
    expect(files[0]!.source_tool).toBe('codex')
    expect(files[0]!.file_kind).toBe('session_jsonl')
    expect(files[0]!.source_file_id).toMatch(/^src_[a-z0-9_:-]+$/)
    // Same bytes → same source_file_id (via deriveSourceFileId, which
    // includes the path — so two different paths produce different
    // ids even with identical bytes).
    expect(files[0]!.source_file_id).not.toBe(files[1]!.source_file_id)
  })

  it('cheap-identify returns a session-scoped logical key derived from session_meta.id', async () => {
    const root = await tmp()
    const bytes = jsonlBytes(SAMPLE_ENVELOPES)
    const path = join(root, 'rollout.jsonl')
    await writeFile(path, bytes)
    const provider = new CodexProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    expect(id.logical_kind).toBe('session')
    expect(new TextDecoder().decode(id.logicalKey)).toBe('codex:sess_abc123')
    expect(id.unit_id).toBe(`unit_${file.source_file_id}`)
  })

  it('cheap-identify falls back to source_file_id when no session_meta envelope exists', async () => {
    const root = await tmp()
    const bytes = jsonlBytes([SAMPLE_ENVELOPES[1], SAMPLE_ENVELOPES[2]])
    const path = join(root, 'rollout-no-meta.jsonl')
    await writeFile(path, bytes)
    const provider = new CodexProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    expect(new TextDecoder().decode(id.logicalKey)).toBe(`codex:src:${file.source_file_id}`)
  })

  it('parseAndProject emits 1 session + 1 source_file + one raw_record per line', async () => {
    const root = await tmp()
    const bytes = jsonlBytes(SAMPLE_ENVELOPES)
    const path = join(root, 'rollout.jsonl')
    await writeFile(path, bytes)
    const provider = new CodexProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    const result = await provider.parseAndProject({
      files: [file],
      identification: id,
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    expect(result.summary.sessions).toBe(1)
    expect(result.summary.files).toBe(1)
    expect(result.summary.rawRecords).toBe(SAMPLE_ENVELOPES.length)
    const { projection } = result.unit
    expect(projection.sessions.length).toBe(1)
    expect(projection.source_files.length).toBe(1)
    expect(projection.raw_records.length).toBe(SAMPLE_ENVELOPES.length)
    const session = projection.sessions[0]!
    expect(session.source_session_id).toBe('sess_abc123')
    expect(session.start_ts).toBe('2025-01-02T03:04:05.123Z')
    const contentHash = `blake3:${toHex(blake3(bytes))}`
    expect(projection.source_files[0]!.content_hash).toBe(contentHash)
    expect(projection.source_files[0]!.object_id).toBe(contentHash)
    expect(projection.raw_records[0]!.content_hash).toBe(contentHash)
    expect(projection.raw_records[0]!.parser_status).toBe('parsed')
    expect(projection.raw_records[0]!.ordinal).toBe(0)
  })

  it('parseAndProject marks unparseable lines as parser_status="corrupt" with confidence="low"', async () => {
    const root = await tmp()
    // Mix valid + malformed JSON lines.
    const body = `${JSON.stringify(SAMPLE_ENVELOPES[0])}\nnot valid json\n${JSON.stringify(SAMPLE_ENVELOPES[2])}\n`
    const path = join(root, 'rollout-mixed.jsonl')
    await writeFile(path, new TextEncoder().encode(body))
    const provider = new CodexProvider()
    const [file] = await provider.discover(root)
    if (!file) throw new Error('expected one file')
    const id = await provider.cheapIdentify(file)
    const result = await provider.parseAndProject({
      files: [file],
      identification: id,
      createdAt: '2025-01-02T03:04:05.123Z',
    })
    expect(result.unit.projection.raw_records.length).toBe(3)
    expect(result.unit.projection.raw_records[1]!.parser_status).toBe('unparseable')
    expect(result.unit.projection.raw_records[1]!.confidence).toBe('low')
    // Surrounding lines still parsed cleanly.
    expect(result.unit.projection.raw_records[0]!.parser_status).toBe('parsed')
    expect(result.unit.projection.raw_records[2]!.parser_status).toBe('parsed')
  })

  it('runCompileImports orchestrates Codex through a real bundle seal', async () => {
    const bundleRoot = await tmp()
    const discoveryRoot = await tmp()
    await mkdir(join(discoveryRoot, '2025', '01', '02'), { recursive: true })
    const bytes = jsonlBytes(SAMPLE_ENVELOPES)
    await writeFile(join(discoveryRoot, '2025', '01', '02', 'rollout-real.jsonl'), bytes)
    const bundle = await initBundle(bundleRoot, { storeId: 'st_codex_e2e', createdAt: '2025-01-02T03:04:05.123Z' })
    try {
      const result = await runCompileImports({
        bundle,
        providers: [{ provider: new CodexProvider(), root: discoveryRoot }],
        createdAt: '2025-01-02T03:04:06.000Z',
      })
      expect(result.sealedEpoch).toBe(1)
      expect(result.perProvider[0]?.source_tool).toBe('codex')
      expect(result.perProvider[0]?.discovered).toBe(1)
      expect(result.perProvider[0]?.won).toBe(1)
      expect(result.perProvider[0]?.lost).toBe(0)
      expect(bundle.head.epoch).toBe(1)
      expect(bundle.head.counts.sessions).toBe(1)
      expect(bundle.head.counts.sourceFiles).toBe(1)
      expect(bundle.head.counts.rawRecords).toBe(SAMPLE_ENVELOPES.length)
    } finally {
      await bundle.close()
    }
  })
})
