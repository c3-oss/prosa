import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { PROSA_MCP_INSTRUCTIONS } from '../../src/mcp/guidance.js';
import { registerProsaTools } from '../../src/mcp/tools.js';
import { createTempBundle } from '../helpers/tmp-bundle.js';

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
    expect(PROSA_MCP_INSTRUCTIONS).toContain('search_sessions');
    expect(PROSA_MCP_INSTRUCTIONS).toContain('find_touched_files');
    expect(PROSA_MCP_INSTRUCTIONS).toContain('get_session');
    expect(PROSA_MCP_INSTRUCTIONS).toContain('session_id');
  });
});

function extractText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return content?.[0]?.text ?? '';
}

function extractPromptText(result: unknown): string {
  const messages = (result as { messages?: Array<{ content?: { text?: string } }> }).messages;
  return messages?.[0]?.content?.text ?? '';
}
