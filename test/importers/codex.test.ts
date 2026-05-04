import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileCodex } from '../../src/importers/codex/index.js';
import { exportSessionMarkdown } from '../../src/services/export/markdown.js';
import { searchFullText } from '../../src/services/search.js';
import { getSession, listSessions } from '../../src/services/sessions.js';
import { createTempBundle } from '../helpers/tmp-bundle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.resolve(__dirname, '../fixtures/codex');

if (!existsSync(FIXTURES)) {
  throw new Error(`fixtures missing at ${FIXTURES}`);
}

describe('codex importer', () => {
  it('compiles two synthetic sessions end-to-end', async () => {
    const t = await createTempBundle();
    try {
      const result = await compileCodex(t.bundle, FIXTURES);
      expect(result.counts.source_files_seen).toBe(2);
      expect(result.counts.source_files_imported).toBe(2);
      expect(result.counts.source_files_skipped).toBe(0);
      expect(result.counts.sessions).toBe(2);
      expect(result.counts.turns).toBe(2);
      // 3 messages in fixture A (user, assistant, agent_message is event_msg not message)
      // and 1 in fixture B
      expect(result.counts.messages).toBe(3);
      expect(result.counts.tool_calls).toBe(2);
      // Each call gets two tool_results: one from function_call_output, one
      // from event_msg.exec_command_end.
      expect(result.counts.tool_results).toBe(4);

      const sessions = listSessions(t.bundle, { sourceTool: 'codex' });
      expect(sessions).toHaveLength(2);

      const subagent = sessions.find((s) => s.is_subagent === 1);
      expect(subagent).toBeDefined();
      expect(subagent?.parent_session_id).not.toBeNull();
      // The parent session must exist in the same listing.
      expect(sessions.some((s) => s.session_id === subagent?.parent_session_id)).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  it('is idempotent — second compile imports zero new files', async () => {
    const t = await createTempBundle();
    try {
      const r1 = await compileCodex(t.bundle, FIXTURES);
      expect(r1.counts.source_files_imported).toBe(2);

      const r2 = await compileCodex(t.bundle, FIXTURES);
      expect(r2.counts.source_files_seen).toBe(2);
      expect(r2.counts.source_files_imported).toBe(0);
      expect(r2.counts.source_files_skipped).toBe(2);

      const sessionCount = t.bundle.db
        .prepare<[], { n: number }>(`SELECT count(*) AS n FROM sessions`)
        .get();
      expect(sessionCount?.n).toBe(2);
    } finally {
      await t.cleanup();
    }
  });

  it('search returns hits with FTS5 snippets', async () => {
    const t = await createTempBundle();
    try {
      await compileCodex(t.bundle, FIXTURES);
      const hits = searchFullText(t.bundle, { query: 'terraform' });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.snippet).toContain('⟪');
    } finally {
      await t.cleanup();
    }
  });

  it('exports a session as markdown with header and transcript', async () => {
    const t = await createTempBundle();
    try {
      await compileCodex(t.bundle, FIXTURES);
      const sessions = listSessions(t.bundle, { sourceTool: 'codex' });
      const main = sessions.find((s) => s.is_subagent === 0);
      expect(main).toBeDefined();
      const md = await exportSessionMarkdown(t.bundle, main!.session_id);
      expect(md).toMatch(/^# /);
      expect(md).toMatch(/source_session_id/);
      expect(md).toMatch(/Run terraform plan/);
      expect(md).toMatch(/tool: shell/);
    } finally {
      await t.cleanup();
    }
  });

  it('getSession returns timeline events ordered by ordinal', async () => {
    const t = await createTempBundle();
    try {
      await compileCodex(t.bundle, FIXTURES);
      const sessions = listSessions(t.bundle, { sourceTool: 'codex' });
      const main = sessions.find((s) => s.is_subagent === 0);
      const detail = getSession(t.bundle, main!.session_id);
      expect(detail).not.toBeNull();
      expect(detail!.events.length).toBeGreaterThan(0);
      // ordinals must be monotonically non-decreasing
      let prev = Number.NEGATIVE_INFINITY;
      for (const e of detail!.events) {
        expect(e.ordinal).toBeGreaterThanOrEqual(prev);
        prev = e.ordinal;
      }
    } finally {
      await t.cleanup();
    }
  });
});
