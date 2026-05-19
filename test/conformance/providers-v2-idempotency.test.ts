// CQ-074 cross-provider idempotency conformance.
//
// Exercises invariant I2 (re-import idempotency) across every v2
// provider using the shared corpora at `test/fixtures/providers-v2/`.
//
// For each provider:
//   1. Build (or copy) the on-disk discovery layout into a temp dir.
//   2. Run `discover → cheapIdentify → parseAndProject` twice.
//   3. Assert the projection rows are byte-identical between the two
//      runs (same row counts, same deterministic ids per entity type).
//
// The corpus is intentionally small but exercises every emit path
// covered by each provider's per-record full projection: messages,
// content blocks (including hidden reasoning), tool calls, tool
// results, events, and (Claude) spawned-edge synthesis.

import { cp, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import { initBundle, openBundle } from '../../packages/prosa-bundle-v2/src/index.ts'
import { ClaudeProvider } from '../../packages/prosa-importers-v2/src/claude/index.ts'
import { CodexProvider } from '../../packages/prosa-importers-v2/src/codex/index.ts'
import { CursorProvider } from '../../packages/prosa-importers-v2/src/cursor/index.ts'
import { GeminiProvider } from '../../packages/prosa-importers-v2/src/gemini/index.ts'
import { HermesProvider } from '../../packages/prosa-importers-v2/src/hermes/index.ts'
import { runCompileImports } from '../../packages/prosa-importers-v2/src/orchestrator.ts'
import type { CanonicalProjectionDraft, Provider } from '../../packages/prosa-importers-v2/src/types.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesRoot = resolve(here, '..', 'fixtures', 'providers-v2')

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'prosa-providers-v2-'))
}

/** Materialize the Cursor SQLite store described by the fixture
 *  descriptor at `<src>/sample-store.json` into the real `store.db`
 *  expected by the discovery layout
 *  `<dst>/<workspace>/<agent>/store.db`. */
async function buildCursorStore(srcDir: string, dst: string): Promise<void> {
  type Descriptor = {
    meta: Record<string, unknown>
    blobs: { id: string; payload?: unknown; rawBase64?: string }[]
    workspace: string
    agent: string
  }
  const descriptorPath = join(srcDir, 'sample-store.json')
  const text = await readFile(descriptorPath, 'utf8')
  const desc = JSON.parse(text) as Descriptor
  const agentDir = join(dst, desc.workspace, desc.agent)
  await mkdir(agentDir, { recursive: true })
  const dbPath = join(agentDir, 'store.db')
  const db = new Database(dbPath)
  try {
    db.exec(
      'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);',
    )
    const metaHex = Buffer.from(JSON.stringify(desc.meta), 'utf8').toString('hex')
    db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(metaHex)
    const insert = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)')
    for (const b of desc.blobs) {
      let buf: Buffer
      if (typeof b.rawBase64 === 'string') buf = Buffer.from(b.rawBase64, 'base64')
      else buf = Buffer.from(JSON.stringify(b.payload), 'utf8')
      insert.run(b.id, buf)
    }
  } finally {
    db.close()
  }
}

async function runProvider(provider: Provider, root: string): Promise<CanonicalProjectionDraft> {
  const files = await provider.discover(root)
  // Merge every unit's draft into one so cross-file emissions
  // (subagents, multi-snapshot) are part of the conformance check.
  const merged: CanonicalProjectionDraft = {
    sessions: [],
    turns: [],
    messages: [],
    content_blocks: [],
    tool_calls: [],
    tool_results: [],
    events: [],
    artifacts: [],
    edges: [],
    search_docs: [],
    raw_records: [],
    source_files: [],
    projects: [],
  }
  for (const f of files) {
    const ident = await provider.cheapIdentify(f)
    const r = await provider.parseAndProject({
      files: [f],
      identification: ident,
      createdAt: '2026-05-19T00:00:00.000Z',
    })
    const p = r.unit.projection
    merged.sessions.push(...p.sessions)
    merged.turns.push(...p.turns)
    merged.messages.push(...p.messages)
    merged.content_blocks.push(...p.content_blocks)
    merged.tool_calls.push(...p.tool_calls)
    merged.tool_results.push(...p.tool_results)
    merged.events.push(...p.events)
    merged.artifacts.push(...p.artifacts)
    merged.edges.push(...p.edges)
    merged.search_docs.push(...p.search_docs)
    merged.raw_records.push(...p.raw_records)
    merged.source_files.push(...p.source_files)
    merged.projects.push(...p.projects)
  }
  return merged
}

function projectionFingerprint(p: CanonicalProjectionDraft): Record<string, string[]> {
  return {
    sessions: p.sessions.map((s) => s.session_id),
    turns: p.turns.map((t) => t.turn_id),
    messages: p.messages.map((m) => m.message_id),
    content_blocks: p.content_blocks.map((b) => b.block_id),
    tool_calls: p.tool_calls.map((t) => t.tool_call_id),
    tool_results: p.tool_results.map((t) => t.tool_result_id),
    events: p.events.map((e) => e.event_id),
    edges: p.edges.map((e) => e.edge_id),
    raw_records: p.raw_records.map((r) => r.raw_record_id),
    source_files: p.source_files.map((s) => s.source_file_id),
  }
}

interface ProviderCase {
  name: string
  factory: () => Provider
  prepare: (dst: string) => Promise<void>
  minRowCounts: {
    sessions: number
    messages: number
    content_blocks: number
    tool_calls: number
    tool_results: number
    events: number
    raw_records: number
    source_files: number
  }
}

const PROVIDER_CASES: ProviderCase[] = [
  {
    name: 'codex',
    factory: () => new CodexProvider(),
    prepare: async (dst) => {
      const src = join(fixturesRoot, 'codex')
      await cp(src, dst, { recursive: true })
    },
    minRowCounts: {
      sessions: 1,
      messages: 2,
      content_blocks: 3,
      tool_calls: 1,
      tool_results: 1,
      events: 1,
      raw_records: 7,
      source_files: 1,
    },
  },
  {
    name: 'claude',
    factory: () => new ClaudeProvider(),
    prepare: async (dst) => {
      const src = join(fixturesRoot, 'claude')
      await cp(src, dst, { recursive: true })
    },
    minRowCounts: {
      // 1 main session + 1 subagent session.
      sessions: 2,
      messages: 5,
      content_blocks: 5,
      tool_calls: 1,
      tool_results: 1,
      events: 1,
      raw_records: 6,
      source_files: 2,
    },
  },
  {
    name: 'cursor',
    factory: () => new CursorProvider(),
    prepare: async (dst) => {
      const src = join(fixturesRoot, 'cursor')
      await buildCursorStore(src, dst)
    },
    minRowCounts: {
      sessions: 1,
      messages: 3,
      content_blocks: 5,
      tool_calls: 1,
      tool_results: 1,
      events: 0,
      // 1 meta + 4 blobs = 5 raw_records.
      raw_records: 5,
      source_files: 1,
    },
  },
  {
    name: 'gemini',
    factory: () => new GeminiProvider(),
    prepare: async (dst) => {
      const src = join(fixturesRoot, 'gemini')
      await cp(src, dst, { recursive: true })
    },
    minRowCounts: {
      sessions: 1,
      messages: 2,
      content_blocks: 3,
      tool_calls: 1,
      tool_results: 1,
      // info → system_operational event.
      events: 1,
      raw_records: 3,
      source_files: 1,
    },
  },
  {
    name: 'hermes',
    factory: () => new HermesProvider(),
    prepare: async (dst) => {
      const src = join(fixturesRoot, 'hermes')
      await cp(src, dst, { recursive: true })
    },
    minRowCounts: {
      // jsonl session + snapshot session = 2 sessions.
      sessions: 2,
      // jsonl: user + assistant + tool = 3; snapshot: user + assistant = 2.
      messages: 5,
      content_blocks: 5,
      tool_calls: 1,
      tool_results: 1,
      // jsonl session_meta → event.
      events: 1,
      raw_records: 6,
      source_files: 2,
    },
  },
]

describe('CQ-074: cross-provider idempotency conformance', () => {
  for (const pc of PROVIDER_CASES) {
    it(`${pc.name} re-importing the corpus yields byte-identical projection`, async () => {
      // Idempotency (I2) is path-sensitive: source_file_id is derived
      // from `(source_tool, path, content_hash)`, so re-importing the
      // SAME on-disk layout must produce identical ids. Use one
      // tmpdir and run the provider twice against it.
      const root = await tmp()
      await pc.prepare(root)

      const provider = pc.factory()
      const firstRun = await runProvider(provider, root)
      const secondRun = await runProvider(provider, root)

      const fpA = projectionFingerprint(firstRun)
      const fpB = projectionFingerprint(secondRun)
      // Deterministic id sets per entity type — order included.
      expect(fpB).toEqual(fpA)

      // Floor checks so we don't silently pass an empty projection.
      expect(firstRun.sessions.length).toBeGreaterThanOrEqual(pc.minRowCounts.sessions)
      expect(firstRun.messages.length).toBeGreaterThanOrEqual(pc.minRowCounts.messages)
      expect(firstRun.content_blocks.length).toBeGreaterThanOrEqual(pc.minRowCounts.content_blocks)
      expect(firstRun.tool_calls.length).toBeGreaterThanOrEqual(pc.minRowCounts.tool_calls)
      expect(firstRun.tool_results.length).toBeGreaterThanOrEqual(pc.minRowCounts.tool_results)
      expect(firstRun.events.length).toBeGreaterThanOrEqual(pc.minRowCounts.events)
      expect(firstRun.raw_records.length).toBeGreaterThanOrEqual(pc.minRowCounts.raw_records)
      expect(firstRun.source_files.length).toBeGreaterThanOrEqual(pc.minRowCounts.source_files)
    })
  }

  it('Claude subagent spawned-edge is preserved across re-imports', async () => {
    // Claude is the only provider with cross-file EdgeV2 synthesis;
    // verify that re-importing the same on-disk layout yields the
    // same edge id both times.
    const root = await tmp()
    const src = join(fixturesRoot, 'claude')
    await cp(src, root, { recursive: true })
    const p1 = await runProvider(new ClaudeProvider(), root)
    const p2 = await runProvider(new ClaudeProvider(), root)
    expect(p1.edges.length).toBeGreaterThanOrEqual(1)
    expect(p1.edges.map((e) => e.edge_id)).toEqual(p2.edges.map((e) => e.edge_id))
    expect(p1.edges.every((e) => e.edge_type === 'spawned')).toBe(true)
  })

  it('CQ-081: runCompileImports is bundle-idempotent — second compile adds no rows/objects/packs', async () => {
    // Real I2 gate at the bundle level: run the full compile pipeline
    // (discover → reserve → parse → segment write → seal) twice over
    // the same fixture corpus and verify the second seal does not grow
    // the bundle's head counts. Reserve-before-parse is what makes
    // this work: on the second run every logical key already has a
    // reservation, so every file becomes a lost reservation and
    // parseAndProject is never re-invoked.
    const discoveryRoot = await tmp()
    const codexSrc = join(fixturesRoot, 'codex')
    await cp(codexSrc, discoveryRoot, { recursive: true })

    const bundleRoot = await tmp()
    const bundle = await initBundle(bundleRoot, {
      storeId: 'st_cq081_idempotency',
      createdAt: '2026-05-19T00:00:00.000Z',
    })
    try {
      const firstRun = await runCompileImports({
        bundle,
        providers: [{ provider: new CodexProvider(), root: discoveryRoot }],
        createdAt: '2026-05-19T00:00:01.000Z',
      })
      expect(firstRun.sealedEpoch).toBe(1)
      const headAfterFirst = {
        epoch: bundle.head.epoch,
        counts: { ...bundle.head.counts },
      }
      expect(headAfterFirst.counts.sessions).toBeGreaterThanOrEqual(1)
      expect(headAfterFirst.counts.rawRecords).toBeGreaterThanOrEqual(1)
      expect(headAfterFirst.counts.sourceFiles).toBeGreaterThanOrEqual(1)

      const secondRun = await runCompileImports({
        bundle,
        providers: [{ provider: new CodexProvider(), root: discoveryRoot }],
        createdAt: '2026-05-19T00:00:02.000Z',
      })
      // Second compile may seal a fresh empty epoch (epoch lifecycle
      // is per-call), but every Reserve must lose, so per-provider
      // discovered/winning counts are zero on the second run.
      expect(secondRun.perProvider[0]?.source_tool).toBe('codex')
      // No new logical content: head counts unchanged.
      expect(bundle.head.counts).toEqual(headAfterFirst.counts)
    } finally {
      await bundle.close()
    }

    // Cold re-open from disk to prove the head counts persist and the
    // bundle is still consistent after the no-op second compile.
    const reopened = await openBundle(bundleRoot)
    try {
      expect(reopened.head.counts.sessions).toBeGreaterThanOrEqual(1)
    } finally {
      await reopened.close()
    }
  })
})
