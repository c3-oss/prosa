import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Bundle } from '../../src/core/bundle.js'
import { compileCodex } from '../../src/importers/codex/index.js'
import {
  disableFts5Triggers,
  enableFts5Triggers,
  getSearchIndexStatus,
  rebuildFts5Index,
  rebuildTantivyIndex,
} from '../../src/services/indexing.js'
import { searchFullText } from '../../src/services/search.js'
import { createTempBundle } from '../helpers/tmp-bundle.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const CODEX_FIXTURES = path.resolve(__dirname, '../fixtures/codex')

describe('search indexing', () => {
  it('can defer FTS5 indexing and rebuild it from search_docs', async () => {
    const t = await createTempBundle()
    try {
      disableFts5Triggers(t.bundle)
      await compileCodex(t.bundle, CODEX_FIXTURES)
      enableFts5Triggers(t.bundle)

      expect(searchFullText(t.bundle, { query: 'terraform' })).toHaveLength(0)

      const status = rebuildFts5Index(t.bundle)
      expect(status.status).toBe('ready')
      expect(status.source_doc_count).toBeGreaterThan(0)
      expect(status.indexed_doc_count).toBe(status.source_doc_count)

      const hits = searchFullText(t.bundle, { query: 'terraform' })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0]?.snippet).toContain('⟪')
    } finally {
      await t.cleanup()
    }
  })

  it('builds a Tantivy sidecar and searches with typo tolerance', async () => {
    const t = await createTempBundle()
    try {
      await compileCodex(t.bundle, CODEX_FIXTURES)

      const status = await rebuildTantivyIndex(t.bundle)
      expect(status.status).toBe('ready')
      expect(status.source_doc_count).toBeGreaterThan(0)
      expect(status.indexed_doc_count).toBe(status.source_doc_count)
      expect(typeof status.last_indexed_rowid).toBe('number')
      expect(status.last_indexed_rowid).toBeGreaterThan(0)
      expect(typeof status.schema_fingerprint).toBe('string')
      expect(existsSync(path.join(t.bundle.paths.tantivy, 'prosa-index.json'))).toBe(true)

      const savedStatus = getSearchIndexStatus(t.bundle, 'tantivy')
      expect(savedStatus?.status).toBe('ready')

      const hits = searchFullText(t.bundle, {
        query: 'terrafom paln',
        engine: 'tantivy',
      })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits.some((h) => h.snippet.includes('terraform'))).toBe(true)
    } finally {
      await t.cleanup()
    }
  })

  it('rebuilds incrementally: new search_docs are added without losing old ones', async () => {
    const t = await createTempBundle()
    try {
      await compileCodex(t.bundle, CODEX_FIXTURES)
      const first = await rebuildTantivyIndex(t.bundle)
      expect(first.status).toBe('ready')
      expect(await sidecarMode(t.bundle)).toBe('full')
      const baselineCount = first.indexed_doc_count
      const baselineRowid = first.last_indexed_rowid as number

      insertSyntheticSearchDoc(t.bundle, {
        doc_id: 'synth-1',
        text: 'pancakes with maple syrup are excellent',
      })
      insertSyntheticSearchDoc(t.bundle, {
        doc_id: 'synth-2',
        text: 'we should ship the pancake feature',
      })

      const second = await rebuildTantivyIndex(t.bundle)
      expect(second.status).toBe('ready')
      expect(await sidecarMode(t.bundle)).toBe('incremental')
      expect(second.indexed_doc_count).toBe(baselineCount + 2)
      expect((second.last_indexed_rowid as number) > baselineRowid).toBe(true)

      // Old doc still searchable.
      const oldHits = searchFullText(t.bundle, { query: 'terraform', engine: 'tantivy' })
      expect(oldHits.length).toBeGreaterThan(0)
      // New docs searchable.
      const newHits = searchFullText(t.bundle, { query: 'pancakes', engine: 'tantivy' })
      expect(newHits.length).toBeGreaterThanOrEqual(1)
      expect(newHits.some((h) => h.snippet.toLowerCase().includes('pancake'))).toBe(true)
    } finally {
      await t.cleanup()
    }
  })

  it('forces a full rebuild when the schema fingerprint mismatches', async () => {
    const t = await createTempBundle()
    try {
      await compileCodex(t.bundle, CODEX_FIXTURES)
      await rebuildTantivyIndex(t.bundle)
      expect(await sidecarMode(t.bundle)).toBe('full')

      // Corrupt the persisted fingerprint so the next rebuild can't trust the
      // on-disk segments.
      t.bundle.db.prepare(`UPDATE search_index_status SET schema_fingerprint = 'bogus' WHERE engine = ?`).run('tantivy')

      const status = await rebuildTantivyIndex(t.bundle)
      expect(status.status).toBe('ready')
      expect(await sidecarMode(t.bundle)).toBe('full')
      // Fingerprint is now restored to the canonical value.
      expect(status.schema_fingerprint).not.toBe('bogus')
      expect((status.schema_fingerprint as string).length).toBeGreaterThan(0)
    } finally {
      await t.cleanup()
    }
  })

  it('honors options.overwrite = true to force a full rebuild even with a valid checkpoint', async () => {
    const t = await createTempBundle()
    try {
      await compileCodex(t.bundle, CODEX_FIXTURES)
      await rebuildTantivyIndex(t.bundle)
      expect(await sidecarMode(t.bundle)).toBe('full')

      // No new docs, valid checkpoint — without { overwrite: true } this would be
      // an incremental no-op rebuild.
      const incremental = await rebuildTantivyIndex(t.bundle)
      expect(await sidecarMode(t.bundle)).toBe('incremental')
      expect(incremental.status).toBe('ready')

      const forced = await rebuildTantivyIndex(t.bundle, { overwrite: true })
      expect(await sidecarMode(t.bundle)).toBe('full')
      expect(forced.status).toBe('ready')
    } finally {
      await t.cleanup()
    }
  })
})

interface SyntheticSearchDoc {
  doc_id: string
  text: string
  field_kind?: string
  entity_type?: string
}

function insertSyntheticSearchDoc(bundle: Bundle, doc: SyntheticSearchDoc): void {
  bundle.db
    .prepare(
      `INSERT INTO search_docs (
         doc_id, entity_type, entity_id, session_id, project_id, timestamp,
         role, tool_name, canonical_tool_type, field_kind, text
       ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    )
    .run(doc.doc_id, doc.entity_type ?? 'message', `entity-${doc.doc_id}`, doc.field_kind ?? 'message_text', doc.text)
}

async function sidecarMode(bundle: Bundle): Promise<string | null> {
  const sidecarPath = path.join(bundle.paths.tantivy, 'prosa-index.json')
  if (!existsSync(sidecarPath)) return null
  const json = JSON.parse(await readFile(sidecarPath, 'utf8')) as { mode?: string }
  return json.mode ?? null
}
