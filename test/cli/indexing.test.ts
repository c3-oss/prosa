import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeBundle, initBundle, openBundle } from '../../src/core/bundle.js';
import { searchFullText } from '../../src/services/search.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const BIN = path.join(ROOT, 'src/bin/prosa.ts');
const CODEX_FIXTURES = path.join(ROOT, 'test/fixtures/codex');

describe('index CLI', () => {
  let storePath: string;

  beforeEach(async () => {
    storePath = await mkdtemp(path.join(os.tmpdir(), 'prosa-index-cli-'));
    const bundle = await initBundle(storePath);
    closeBundle(bundle);
  });

  afterEach(async () => {
    await rm(storePath, { recursive: true, force: true });
  });

  it('supports compile --defer-index followed by index fts5', async () => {
    await runProsa(['compile', '--codex', CODEX_FIXTURES, '--store', storePath, '--defer-index']);

    let bundle = await openBundle(storePath);
    try {
      expect(searchFullText(bundle, { query: 'terraform' })).toHaveLength(0);
    } finally {
      closeBundle(bundle);
    }

    const { stdout } = await runProsa(['index', 'fts5', '--store', storePath]);
    expect(stdout).toContain('fts5 index: ready');

    bundle = await openBundle(storePath);
    try {
      expect(searchFullText(bundle, { query: 'terraform' }).length).toBeGreaterThan(0);
    } finally {
      closeBundle(bundle);
    }
  });
});

function runProsa(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    ['--import', '@swc-node/register/esm-register', BIN, ...args],
    {
      cwd: ROOT,
    },
  );
}
