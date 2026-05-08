import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileCodex } from '../../src/importers/codex/index.js';
import { runAnalyticsReport } from '../../src/services/analytics.js';
import { exportBundleParquet } from '../../src/services/export/parquet.js';
import { createTempBundle } from '../helpers/tmp-bundle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const CODEX_FIXTURES = path.join(ROOT, 'test/fixtures/codex');

describe('analytics reports', () => {
  it('runs built-in reports over exported Parquet with filters', async () => {
    const t = await createTempBundle();
    try {
      await compileCodex(t.bundle, CODEX_FIXTURES);
      const parquet = await exportBundleParquet({ bundlePath: t.path });

      const sessions = await runAnalyticsReport({
        parquetDir: parquet.outDir,
        report: 'sessions',
        filters: { source: 'codex', limit: 10 },
      });
      expect(sessions.rows).toHaveLength(2);
      expect(sessions.columns).toContain('session_id');

      const tools = await runAnalyticsReport({
        parquetDir: parquet.outDir,
        report: 'tools',
        filters: { canonicalType: 'shell', limit: 10 },
      });
      expect(tools.rows).toEqual([
        expect.objectContaining({ canonical_tool_type: 'shell', call_count: '2' }),
      ]);

      const errors = await runAnalyticsReport({
        parquetDir: parquet.outDir,
        report: 'errors',
        filters: { limit: 10 },
      });
      expect(errors.rows.length).toBeGreaterThan(0);

      const models = await runAnalyticsReport({
        parquetDir: parquet.outDir,
        report: 'models',
        filters: { model: 'gpt-5.4', limit: 10 },
      });
      expect(models.rows).toEqual([expect.objectContaining({ model: 'gpt-5.4' })]);

      const projects = await runAnalyticsReport({
        parquetDir: parquet.outDir,
        report: 'projects',
        filters: { project: '/Users/test', limit: 10 },
      });
      expect(projects.rows.length).toBeGreaterThan(0);
    } finally {
      await t.cleanup();
    }
  });
});
