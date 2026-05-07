import type { CallToolResult, GetPromptResult } from '@modelcontextprotocol/sdk/types.js';

export function extractText(result: unknown): string {
  const first = (result as CallToolResult).content?.[0];
  return first?.type === 'text' ? first.text : '';
}

export function extractPromptText(result: unknown): string {
  const first = (result as GetPromptResult).messages?.[0];
  return first?.content?.type === 'text' ? first.content.text : '';
}
