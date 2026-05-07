import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { PROSA_MCP_INSTRUCTIONS } from '../../src/mcp/guidance.js';
import { registerProsaTools } from '../../src/mcp/tools.js';
import { extractPromptText, extractText } from '../helpers/mcp.js';
import { createTempBundle } from '../helpers/tmp-bundle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const CODEX_FIXTURES = path.join(ROOT, 'test/fixtures/codex');

interface CapturedTool {
  config: { description?: string };
  callback: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> | unknown;
}

interface CapturedPrompt {
  config: { description?: string };
  callback: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> | unknown;
}

class FakeMcpServer {
  tools = new Map<string, CapturedTool>();
  prompts = new Map<string, CapturedPrompt>();

  registerTool(
    name: string,
    config: CapturedTool['config'],
    callback: CapturedTool['callback'],
  ): unknown {
    this.tools.set(name, { config, callback });
    return {};
  }

  registerPrompt(
    name: string,
    config: CapturedPrompt['config'],
    callback: CapturedPrompt['callback'],
  ): unknown {
    this.prompts.set(name, { config, callback });
    return {};
  }
}

describe('prosa MCP guidance', () => {
  it('registers agent-facing prompts and read-only index status', async () => {
    const t = await createTempBundle();
    try {
      const server = new FakeMcpServer();
      registerProsaTools(server as unknown as McpServer, t.bundle, { searchEngine: 'tantivy' });

      expect([...server.prompts.keys()].sort()).toEqual([
        'audit_tool_failures',
        'find_file_history',
        'investigate_prior_work',
      ]);
      expect(server.tools.has('compile')).toBe(true);
      expect(server.tools.has('index_status')).toBe(true);
      expect(server.tools.get('search_sessions')?.config.description).toContain('tantivy');

      const indexStatus = server.tools.get('index_status');
      expect(indexStatus).toBeDefined();
      const result = await indexStatus!.callback({}, {});
      const text = extractText(result);
      const rows = JSON.parse(text) as Array<{ engine: string; status: string }>;
      expect(rows.map((r) => r.engine).sort()).toEqual(['fts5', 'tantivy']);

      const prompt = server.prompts.get('investigate_prior_work');
      expect(prompt).toBeDefined();
      const promptResult = await prompt!.callback({ topic: 'search indexing' }, {});
      expect(extractPromptText(promptResult)).toContain('search indexing');
      expect(extractPromptText(promptResult)).toContain('get_session');
    } finally {
      await t.cleanup();
    }
  });

  it('exposes MCP server instructions for autonomous agents', () => {
    expect(PROSA_MCP_INSTRUCTIONS).toContain('compile');
    expect(PROSA_MCP_INSTRUCTIONS).toContain('search_sessions');
    expect(PROSA_MCP_INSTRUCTIONS).toContain('find_touched_files');
    expect(PROSA_MCP_INSTRUCTIONS).toContain('get_session');
    expect(PROSA_MCP_INSTRUCTIONS).toContain('session_id');
  });

  it('compiles selected sessions through the MCP tool', async () => {
    const t = await createTempBundle();
    try {
      const server = new FakeMcpServer();
      registerProsaTools(server as unknown as McpServer, t.bundle, { storePath: t.path });

      const compile = server.tools.get('compile');
      expect(compile).toBeDefined();

      const first = await compile!.callback({ source: 'codex', sessions_path: CODEX_FIXTURES }, {});
      const firstPayload = JSON.parse(extractText(first)) as {
        imported_any: boolean;
        providers: Array<{
          source: string;
          source_path: string;
          counts: { source_files_imported: number; source_files_skipped: number };
        }>;
      };
      expect(firstPayload.imported_any).toBe(true);
      expect(firstPayload.providers).toHaveLength(1);
      expect(firstPayload.providers[0]).toMatchObject({
        source: 'codex',
        source_path: CODEX_FIXTURES,
      });
      expect(firstPayload.providers[0]?.counts.source_files_imported).toBe(2);

      const second = await compile!.callback(
        { source: 'codex', sessions_path: CODEX_FIXTURES },
        {},
      );
      const secondPayload = JSON.parse(extractText(second)) as {
        imported_any: boolean;
        providers: Array<{
          counts: { source_files_imported: number; source_files_skipped: number };
        }>;
      };
      expect(secondPayload.imported_any).toBe(false);
      expect(secondPayload.providers[0]?.counts.source_files_imported).toBe(0);
      expect(secondPayload.providers[0]?.counts.source_files_skipped).toBe(2);

      const invalid = await compile!.callback({ sessions_path: CODEX_FIXTURES }, {});
      expect((invalid as { isError?: boolean }).isError).toBe(true);
      expect(extractText(invalid)).toContain('sessions_path requires source');
    } finally {
      await t.cleanup();
    }
  });
});
