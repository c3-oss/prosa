import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileCodex } from '../../src/importers/codex/index.js';
import {
  PARQUET_TABLES,
  exportBundleParquet,
  queryDuckDbParquet,
} from '../../src/services/export/parquet.js';
import { createTempBundle } from '../helpers/tmp-bundle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const CODEX_FIXTURES = path.join(ROOT, 'test/fixtures/codex');

describe('parquet export', () => {
  it('exports canonical tables with a manifest and queryable Parquet files', async () => {
    const t = await createTempBundle();
    try {
      await compileCodex(t.bundle, CODEX_FIXTURES);

      const result = await exportBundleParquet({ bundlePath: t.path });

      for (const table of PARQUET_TABLES) {
        const fileStat = await stat(result.files[table]);
        expect(fileStat.isFile()).toBe(true);
      }

      const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as {
        tables: Record<string, { rows: number; file: string }>;
      };
      expect(manifest.tables.sessions?.rows).toBe(2);
      expect(manifest.tables.messages?.rows).toBe(3);
      expect(manifest.tables.tool_calls?.rows).toBe(2);

      const query = await queryDuckDbParquet({
        parquetDir: result.outDir,
        sql: 'select source_tool, count(*) as n from sessions group by source_tool',
      });
      expect(query.columns).toEqual(['source_tool', 'n']);
      expect(query.rows).toEqual([{ source_tool: 'codex', n: '2' }]);

      const sessionFacts = await queryDuckDbParquet({
        parquetDir: result.outDir,
        sql: 'select count(*) as n from session_facts',
      });
      expect(sessionFacts.rows).toEqual([{ n: '2' }]);

      const toolFacts = await queryDuckDbParquet({
        parquetDir: result.outDir,
        sql: 'select count(*) as n from tool_usage_facts',
      });
      expect(toolFacts.rows).toEqual([{ n: '2' }]);

      const modelUsage = await queryDuckDbParquet({
        parquetDir: result.outDir,
        sql: "select model, session_count from model_usage where model = 'gpt-5.4'",
      });
      expect(modelUsage.rows).toEqual([{ model: 'gpt-5.4', session_count: '2' }]);

      const projectActivity = await queryDuckDbParquet({
        parquetDir: result.outDir,
        sql: 'select source_tool, sum(session_count) as session_count from project_activity group by 1',
      });
      expect(projectActivity.rows).toEqual([{ source_tool: 'codex', session_count: '2' }]);

      const errorFacts = await queryDuckDbParquet({
        parquetDir: result.outDir,
        sql: 'select count(*) as n from error_facts',
      });
      expect(Number(errorFacts.rows[0]?.n)).toBeGreaterThanOrEqual(0);
    } finally {
      await t.cleanup();
    }
  });
});
