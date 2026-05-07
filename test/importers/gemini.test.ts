import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileGemini } from '../../src/importers/gemini/index.js';
import { exportSessionMarkdown } from '../../src/services/export/markdown.js';
import { searchFullText } from '../../src/services/search.js';
import { listSessions } from '../../src/services/sessions.js';
import { createTempBundle, queryCount } from '../helpers/tmp-bundle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.resolve(__dirname, '../fixtures/gemini');

if (!existsSync(FIXTURES)) {
  throw new Error(`fixtures missing at ${FIXTURES}`);
}

describe('gemini importer', () => {
  it('compiles the synthetic chat including tool call and project link', async () => {
    const t = await createTempBundle();
    try {
      const result = await compileGemini(t.bundle, FIXTURES);
      expect(result.counts.source_files_seen).toBe(1);
      expect(result.counts.sessions).toBe(1);
      expect(result.counts.messages).toBe(3); // user + 2 gemini; info/error are events
      expect(result.counts.tool_calls).toBe(1);
      expect(result.counts.tool_results).toBe(1);

      const sessions = listSessions(t.bundle, { sourceTool: 'gemini' });
      expect(sessions).toHaveLength(1);

      const project = t.bundle.db
        .prepare<[], { canonical_path: string | null }>(
          `SELECT canonical_path FROM projects LIMIT 1`,
        )
        .get();
      expect(project?.canonical_path).toBe('/Users/test/proj');

      const md = await exportSessionMarkdown(t.bundle, sessions[0]!.session_id);
      expect(md).toMatch(/Read package.json/);
      expect(md).toMatch(/tool: read_file/);
    } finally {
      await t.cleanup();
    }
  });

  it('treats info and error message types as operational events, not messages', async () => {
    const t = await createTempBundle();
    try {
      await compileGemini(t.bundle, FIXTURES);
      expect(queryCount(t.bundle.db, `SELECT count(*) AS n FROM messages`)).toBe(3);
      expect(
        queryCount(t.bundle.db, `SELECT count(*) AS n FROM events WHERE event_type = 'error'`),
      ).toBe(1);
    } finally {
      await t.cleanup();
    }
  });

  it('hides thoughts from default search', async () => {
    const t = await createTempBundle();
    try {
      await compileGemini(t.bundle, FIXTURES);
      const hits = searchFullText(t.bundle, { query: 'summarize' });
      expect(hits.length).toBe(0);
      const found = searchFullText(t.bundle, { query: 'package.json' });
      expect(found.length).toBeGreaterThan(0);
    } finally {
      await t.cleanup();
    }
  });

  it('is idempotent', async () => {
    const t = await createTempBundle();
    try {
      const r1 = await compileGemini(t.bundle, FIXTURES);
      expect(r1.counts.source_files_imported).toBe(1);
      const r2 = await compileGemini(t.bundle, FIXTURES);
      expect(r2.counts.source_files_imported).toBe(0);
      expect(r2.counts.source_files_skipped).toBe(1);
    } finally {
      await t.cleanup();
    }
  });
});
