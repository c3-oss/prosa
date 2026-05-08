import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { compileCodex } from '../../src/importers/codex/index.js';
import { createTempBundle } from '../helpers/tmp-bundle.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const BIN = path.join(ROOT, 'src/bin/prosa.ts');
const CODEX_FIXTURES = path.join(ROOT, 'test/fixtures/codex');

describe('analytics CLI', () => {
  it('refreshes Parquet and prints analytics reports', async () => {
    const t = await createTempBundle();
    try {
      await compileCodex(t.bundle, CODEX_FIXTURES);

      const sessions = await execProsa([
        'analytics',
        'sessions',
        '--store',
        t.path,
        '--refresh',
        '--output-format',
        'json',
      ]);
      const sessionsPayload = JSON.parse(sessions.stdout) as {
        report: string;
        rows: Array<{ source_tool: string; session_id: string }>;
      };
      expect(sessionsPayload.report).toBe('sessions');
      expect(sessionsPayload.rows).toHaveLength(2);
      expect(sessionsPayload.rows.every((row) => row.source_tool === 'codex')).toBe(true);

      const tools = await execProsa([
        'analytics',
        'tools',
        '--store',
        t.path,
        '--source',
        'codex',
        '--output-format',
        'json',
      ]);
      const toolsPayload = JSON.parse(tools.stdout) as {
        report: string;
        rows: Array<{ source_tool: string; call_count: string }>;
      };
      expect(toolsPayload.report).toBe('tools');
      expect(toolsPayload.rows).toHaveLength(1);
      expect(toolsPayload.rows[0]?.source_tool).toBe('codex');
      expect(toolsPayload.rows[0]?.call_count).toBe('2');

      for (const report of ['errors', 'models', 'projects'] as const) {
        const { stdout } = await execProsa([
          'analytics',
          report,
          '--store',
          t.path,
          '--output-format',
          'json',
        ]);
        const payload = JSON.parse(stdout) as { report: string; rows: unknown[] };
        expect(payload.report).toBe(report);
        expect(Array.isArray(payload.rows)).toBe(true);
      }
    } finally {
      await t.cleanup();
    }
  });
});

function execProsa(args: string[]) {
  return execFileAsync(
    process.execPath,
    ['--import', '@swc-node/register/esm-register', BIN, ...args],
    { cwd: ROOT },
  );
}
