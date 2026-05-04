// Loose TypeScript shapes for Claude Code's JSONL records.

export interface ClaudeRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  isSidechain?: boolean;
  agentId?: string;
  agentName?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  userType?: string;
  entrypoint?: string;
  promptId?: string;
  message?: ClaudeMessage;
  data?: Record<string, unknown>;
  subtype?: string;
  attachment?: ClaudeAttachment;
  snapshot?: { messageId?: string; timestamp?: string };
  isSnapshotUpdate?: boolean;
  toolUseResult?: unknown;
  toolUseID?: string;
  parentToolUseID?: string;
  sourceToolAssistantUUID?: string;
  permissionMode?: string;
  lastPrompt?: string;
  customTitle?: string;
  operation?: string;
  content?: unknown;
  level?: string;
  prNumber?: number;
  prRepository?: string;
  prUrl?: string;
}

export interface ClaudeMessage {
  id?: string;
  role?: string;
  model?: string;
  content?: ClaudeContentBlock[] | string;
  type?: string;
  stop_reason?: string;
  usage?: Record<string, unknown>;
}

export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content?: unknown;
      is_error?: boolean;
    }
  | { type: 'image'; source: unknown }
  | { type: string; [k: string]: unknown };

export interface ClaudeAttachment {
  type?: string;
  fileName?: string;
  filePath?: string;
  content?: unknown;
  [k: string]: unknown;
}

export interface ClaudeSubagentMeta {
  agentType?: string;
  description?: string;
}
