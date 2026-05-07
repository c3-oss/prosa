import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { compileCursor } from '../../src/importers/cursor/index.js';
import { exportSessionMarkdown } from '../../src/services/export/markdown.js';
import { listSessions } from '../../src/services/sessions.js';
import { createTempBundle, queryCount } from '../helpers/tmp-bundle.js';

/**
 * Build a minimal Cursor `store.db` on disk that mimics the structure observed
 * in `~/.cursor/chats/<workspace>/<agent>/store.db`: a `meta` row keyed `'0'`
 * with hex-encoded JSON, and a `blobs` table holding chat messages as JSON.
 */
async function makeCursorFixture(root: string): Promise<{ workspaceId: string; agentId: string }> {
  const workspaceId = 'workspace-test';
  const agentId = '64a9033f-00d4-4870-af5a-d2331bde2876';
  const dir = path.join(root, workspaceId, agentId);
  await mkdir(dir, { recursive: true });
  const dbPath = path.join(dir, 'store.db');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE meta  (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
  `);

  const meta = {
    agentId,
    latestRootBlobId: 'rootblobid',
    name: 'Test agent',
    mode: 'default',
    createdAt: 1774457736671,
    lastUsedModel: 'composer-1.5',
  };
  const metaHex = Buffer.from(JSON.stringify(meta), 'utf8').toString('hex');
  db.prepare(`INSERT INTO meta(key, value) VALUES ('0', ?)`).run(metaHex);

  const insertBlob = db.prepare(`INSERT INTO blobs(id, data) VALUES (?, ?)`);

  const sysMsg = { role: 'system', content: 'You are a coding assistant.' };
  insertBlob.run('sys1', Buffer.from(JSON.stringify(sysMsg), 'utf8'));

  const userMsg = { role: 'user', content: 'list files' };
  insertBlob.run('u1', Buffer.from(JSON.stringify(userMsg), 'utf8'));

  const assistantMsg = {
    role: 'assistant',
    id: 'a1',
    content: [
      { type: 'text', text: 'Listing now.' },
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'Shell', args: { command: 'ls -la' } },
    ],
  };
  insertBlob.run('a1', Buffer.from(JSON.stringify(assistantMsg), 'utf8'));

  const toolMsg = {
    role: 'tool',
    id: 't1',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'tc1',
        toolName: 'Shell',
        result: 'total 0\n.\n..\n',
        experimental_content: { isError: false },
      },
    ],
  };
  insertBlob.run('t1', Buffer.from(JSON.stringify(toolMsg), 'utf8'));

  // A non-JSON blob (random binary), like the protobuf root state. The
  // importer must preserve it as a raw record without crashing.
  insertBlob.run('rootblobid', Buffer.from([0x0a, 0x10, 0x01, 0x12, 0x05, 0xff]));

  db.close();
  return { workspaceId, agentId };
}

describe('cursor importer', () => {
  it('compiles a synthetic Cursor store.db with mixed json/binary blobs', async () => {
    const t = await createTempBundle();
    const fixturesRoot = path.join(t.path, 'cursor-fixtures');
    try {
      await makeCursorFixture(fixturesRoot);
      const result = await compileCursor(t.bundle, fixturesRoot);
      expect(result.counts.source_files_seen).toBe(1);
      expect(result.counts.sessions).toBe(1);
      expect(result.counts.messages).toBe(4); // system, user, assistant, tool
      expect(result.counts.tool_calls).toBe(1);
      expect(result.counts.tool_results).toBe(1);

      const sessions = listSessions(t.bundle, { sourceTool: 'cursor' });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.timeline_confidence).toBe('low');

      const md = await exportSessionMarkdown(t.bundle, sessions[0]!.session_id);
      expect(md).toMatch(/list files/);
      expect(md).toMatch(/tool: Shell/);
    } finally {
      await t.cleanup();
    }
  });

  it('preserves the binary protobuf blob as a raw record without normalizing it', async () => {
    const t = await createTempBundle();
    const fixturesRoot = path.join(t.path, 'cursor-fixtures');
    try {
      await makeCursorFixture(fixturesRoot);
      await compileCursor(t.bundle, fixturesRoot);
      expect(
        queryCount(
          t.bundle.db,
          `SELECT count(*) AS n FROM raw_records
            WHERE source_tool = 'cursor' AND parser_status = 'partial'`,
        ),
      ).toBeGreaterThan(0);
    } finally {
      await t.cleanup();
    }
  });

  it('is idempotent', async () => {
    const t = await createTempBundle();
    const fixturesRoot = path.join(t.path, 'cursor-fixtures');
    try {
      await makeCursorFixture(fixturesRoot);
      const r1 = await compileCursor(t.bundle, fixturesRoot);
      expect(r1.counts.source_files_imported).toBe(1);
      const r2 = await compileCursor(t.bundle, fixturesRoot);
      expect(r2.counts.source_files_imported).toBe(0);
      expect(r2.counts.source_files_skipped).toBe(1);
      // Suppress unused import warning when test is built; writeFile is used
      // implicitly through Database engine. (Kept import for parity.)
      void writeFile;
    } finally {
      await t.cleanup();
    }
  });
});
