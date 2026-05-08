import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileCodex } from '../../src/importers/codex/index.js';
import { listToolCalls } from '../../src/services/tool_calls.js';
import { createTempBundle } from '../helpers/tmp-bundle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const CODEX_FIXTURES = path.join(ROOT, 'test/fixtures/codex');

describe('listToolCalls', () => {
  it('returns tool_call rows filtered by canonical_type', async () => {
    const t = await createTempBundle();
    try {
      await compileCodex(t.bundle, CODEX_FIXTURES);

      const rows = listToolCalls(t.bundle, { canonicalType: 'shell' });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.entity_type === 'tool_call')).toBe(true);
      expect(rows.every((r) => r.canonical_tool_type === 'shell')).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  it('returns an empty result when path_substring matches nothing', async () => {
    const t = await createTempBundle();
    try {
      await compileCodex(t.bundle, CODEX_FIXTURES);

      const rows = listToolCalls(t.bundle, { pathSubstring: 'no-such-path-aaaa' });
      expect(rows).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });

  it('errors_only returns only rows with errors', async () => {
    const t = await createTempBundle();
    try {
      await compileCodex(t.bundle, CODEX_FIXTURES);

      const rows = listToolCalls(t.bundle, { errorsOnly: true });
      for (const row of rows) {
        expect(row.is_error === 1 || row.status === 'error').toBe(true);
      }
    } finally {
      await t.cleanup();
    }
  });

  it('applies time filters and tool_name + session_id filters', async () => {
    const t = await createTempBundle();
    try {
      await compileCodex(t.bundle, CODEX_FIXTURES);

      // Far-future since: nothing should match.
      const future = listToolCalls(t.bundle, { sinceIso: '3000-01-01T00:00:00Z' });
      expect(future).toEqual([]);

      // Far-past until: nothing should match either.
      const past = listToolCalls(t.bundle, { untilIso: '1900-01-01T00:00:00Z' });
      expect(past).toEqual([]);

      const all = listToolCalls(t.bundle, { canonicalType: 'shell' });
      expect(all.length).toBeGreaterThan(0);
      const sample = all[0]!;
      const bySession = listToolCalls(t.bundle, {
        sessionId: sample.session_id ?? '',
        toolName: sample.tool_name ?? '',
      });
      expect(bySession.length).toBeGreaterThan(0);
      expect(bySession.every((row) => row.session_id === sample.session_id)).toBe(true);
      expect(bySession.every((row) => row.tool_name === sample.tool_name)).toBe(true);
    } finally {
      await t.cleanup();
    }
  });
});
