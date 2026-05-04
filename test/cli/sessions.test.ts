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

describe('sessions CLI', () => {
  it('prints a filtered session count', async () => {
    const t = await createTempBundle();
    try {
      await compileCodex(t.bundle, CODEX_FIXTURES);

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          '--import',
          '@swc-node/register/esm-register',
          BIN,
          'sessions',
          'count',
          '--store',
          t.path,
          '--source',
          'codex',
          '--since',
          '2026-05-03T21:15:00.000Z',
        ],
        { cwd: ROOT },
      );

      expect(stdout).toBe('1\n');
    } finally {
      await t.cleanup();
    }
  });
});
