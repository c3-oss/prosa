import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileCodex } from '../../src/importers/codex/index.js';
import {
  disableFts5Triggers,
  enableFts5Triggers,
  getSearchIndexStatus,
  rebuildFts5Index,
  rebuildTantivyIndex,
} from '../../src/services/indexing.js';
import { searchFullText } from '../../src/services/search.js';
import { createTempBundle } from '../helpers/tmp-bundle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CODEX_FIXTURES = path.resolve(__dirname, '../fixtures/codex');

describe('search indexing', () => {
  it('can defer FTS5 indexing and rebuild it from search_docs', async () => {
    const t = await createTempBundle();
    try {
      disableFts5Triggers(t.bundle);
      await compileCodex(t.bundle, CODEX_FIXTURES);
      enableFts5Triggers(t.bundle);

      expect(searchFullText(t.bundle, { query: 'terraform' })).toHaveLength(0);

      const status = rebuildFts5Index(t.bundle);
      expect(status.status).toBe('ready');
      expect(status.source_doc_count).toBeGreaterThan(0);
      expect(status.indexed_doc_count).toBe(status.source_doc_count);

      const hits = searchFullText(t.bundle, { query: 'terraform' });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.snippet).toContain('⟪');
    } finally {
      await t.cleanup();
    }
  });

  it('builds a Tantivy sidecar and searches with typo tolerance', async () => {
    const t = await createTempBundle();
    try {
      await compileCodex(t.bundle, CODEX_FIXTURES);

      const status = await rebuildTantivyIndex(t.bundle);
      expect(status.status).toBe('ready');
      expect(status.source_doc_count).toBeGreaterThan(0);
      expect(status.indexed_doc_count).toBe(status.source_doc_count);
      expect(existsSync(path.join(t.bundle.paths.tantivy, 'prosa-index.json'))).toBe(true);

      const savedStatus = getSearchIndexStatus(t.bundle, 'tantivy');
      expect(savedStatus?.status).toBe('ready');

      const hits = searchFullText(t.bundle, {
        query: 'terrafom paln',
        engine: 'tantivy',
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((h) => h.snippet.includes('terraform'))).toBe(true);
    } finally {
      await t.cleanup();
    }
  });
});
