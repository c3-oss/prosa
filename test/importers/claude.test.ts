import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileClaude } from '../../src/importers/claude/index.js';
import { exportSessionMarkdown } from '../../src/services/export/markdown.js';
import { searchFullText } from '../../src/services/search.js';
import { getSession, listSessions } from '../../src/services/sessions.js';
import { createTempBundle } from '../helpers/tmp-bundle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.resolve(__dirname, '../fixtures/claude');

if (!existsSync(FIXTURES)) {
  throw new Error(`fixtures missing at ${FIXTURES}`);
}

describe('claude importer', () => {
  it('compiles main session and subagent', async () => {
    const t = await createTempBundle();
    try {
      const result = await compileClaude(t.bundle, FIXTURES);
      expect(result.counts.source_files_seen).toBe(2);
      expect(result.counts.source_files_imported).toBe(2);
      expect(result.counts.sessions).toBe(2);
      // 5 user/assistant in main (u1, u2, u3, u4, u6) + 3 in subagent = 8.
      expect(result.counts.messages).toBe(8);
      // 2 tool_use in main + 1 in subagent
      expect(result.counts.tool_calls).toBe(3);
      // 1 tool_result in main + 1 in subagent
      expect(result.counts.tool_results).toBe(2);

      const sessions = listSessions(t.bundle, { sourceTool: 'claude' });
      expect(sessions).toHaveLength(2);

      const sub = sessions.find((s) => s.is_subagent === 1);
      expect(sub).toBeDefined();
      expect(sub?.parent_session_id).not.toBeNull();
      const parent = sessions.find((s) => s.session_id === sub?.parent_session_id);
      expect(parent).toBeDefined();
      expect(parent?.is_subagent).toBe(0);
    } finally {
      await t.cleanup();
    }
  });

  it('does not treat type="system" as a system_prompt message', async () => {
    const t = await createTempBundle();
    try {
      await compileClaude(t.bundle, FIXTURES);
      const systemMessages = t.bundle.db
        .prepare<[], { n: number }>(
          `SELECT count(*) AS n FROM messages WHERE role = 'system_prompt'`,
        )
        .get();
      expect(systemMessages?.n).toBe(0);

      const sysOpEvents = t.bundle.db
        .prepare<[], { n: number }>(
          `SELECT count(*) AS n FROM events WHERE event_type = 'system_operational' AND source_type = 'system'`,
        )
        .get();
      expect(sysOpEvents?.n).toBeGreaterThan(0);
    } finally {
      await t.cleanup();
    }
  });

  it('matches tool_use to tool_result via tool_use_id', async () => {
    const t = await createTempBundle();
    try {
      await compileClaude(t.bundle, FIXTURES);
      const orphans = t.bundle.db
        .prepare<[], { n: number }>(
          `SELECT count(*) AS n
             FROM tool_results tr
            WHERE tr.tool_call_id IS NULL
              AND tr.source_call_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM tool_calls tc WHERE tc.source_call_id = tr.source_call_id)`,
        )
        .get();
      expect(orphans?.n).toBe(0);
    } finally {
      await t.cleanup();
    }
  });

  it('records parent_of edges for chained messages', async () => {
    const t = await createTempBundle();
    try {
      await compileClaude(t.bundle, FIXTURES);
      const edges = t.bundle.db
        .prepare<[], { n: number }>(`SELECT count(*) AS n FROM edges WHERE edge_type = 'parent_of'`)
        .get();
      expect(edges?.n).toBeGreaterThan(0);
    } finally {
      await t.cleanup();
    }
  });

  it('is idempotent on re-import', async () => {
    const t = await createTempBundle();
    try {
      const r1 = await compileClaude(t.bundle, FIXTURES);
      expect(r1.counts.source_files_imported).toBe(2);
      const r2 = await compileClaude(t.bundle, FIXTURES);
      expect(r2.counts.source_files_imported).toBe(0);
      expect(r2.counts.source_files_skipped).toBe(2);
    } finally {
      await t.cleanup();
    }
  });

  it('exports a session as markdown including the tool calls', async () => {
    const t = await createTempBundle();
    try {
      await compileClaude(t.bundle, FIXTURES);
      const sessions = listSessions(t.bundle, { sourceTool: 'claude' });
      const main = sessions.find((s) => s.is_subagent === 0);
      const md = await exportSessionMarkdown(t.bundle, main!.session_id);
      expect(md).toMatch(/grep for TODO/);
      expect(md).toMatch(/tool: Bash/);
    } finally {
      await t.cleanup();
    }
  });

  it('finds matches via FTS5', async () => {
    const t = await createTempBundle();
    try {
      await compileClaude(t.bundle, FIXTURES);
      const hits = searchFullText(t.bundle, { query: 'TODO' });
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      await t.cleanup();
    }
  });

  it('returns timeline events for a session', async () => {
    const t = await createTempBundle();
    try {
      await compileClaude(t.bundle, FIXTURES);
      const sessions = listSessions(t.bundle, { sourceTool: 'claude' });
      const detail = getSession(t.bundle, sessions[0]!.session_id);
      expect(detail!.events.length).toBeGreaterThan(0);
    } finally {
      await t.cleanup();
    }
  });
});
