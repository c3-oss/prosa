// Row-shaped TypeScript types matching the SQLite schema. These are the
// boundary contract between importers and the catalog. Optional fields use
// `null` (not `undefined`) to mirror SQLite NULL semantics directly.

/**
 * Source tools that have first-class importer support and stable schema
 * semantics.
 */
export const SOURCE_TOOLS = ['cursor', 'codex', 'claude', 'gemini'] as const

/**
 * Normalized source-tool discriminator stored on source files, raw records,
 * sessions, and analytics views.
 */
export type SourceTool = (typeof SOURCE_TOOLS)[number]

/**
 * Confidence level for inferred timeline positions and recovered relations.
 */
export type Confidence = 'high' | 'medium' | 'low'

/**
 * Canonical message role vocabulary used by the `messages.role` CHECK
 * constraint. `operational` is reserved for runtime/system events that are not
 * user-visible system prompts.
 */
export type MessageRole = 'system_prompt' | 'developer' | 'user' | 'assistant' | 'tool' | 'operational'

/**
 * Coarse tool categories used for cross-importer aggregation while preserving
 * the native tool name separately.
 */
export type CanonicalToolType =
  | 'shell'
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'search_file'
  | 'web_search'
  | 'mcp'
  | 'subagent'
  | 'patch'
  | 'other'

/**
 * Directed graph relationship vocabulary for `edges`, covering conversation
 * lineage, tool call/result links, artifacts, and recovered equivalence.
 */
export type EdgeType =
  | 'parent_of'
  | 'calls'
  | 'returns'
  | 'spawned'
  | 'contains'
  | 'produced'
  | 'consumed'
  | 'derived_from'
  | 'summarizes'
  | 'compacts'
  | 'same_as'
  | 'refers_to'

/**
 * Importer-normalized lifecycle state for tool calls when the source format
 * provides enough evidence to distinguish outcomes.
 */
export type ToolCallStatus = 'started' | 'success' | 'error' | 'cancelled' | 'unknown'

/**
 * Complete row projection for the `sessions` table.
 *
 * Boolean flags are represented as SQLite integers and absent values are
 * represented as `null` so callers can bind/read rows without conversion.
 */
export interface SessionRowFull {
  /** Canonical prosa session identifier. */
  session_id: string
  /** Source tool that produced the session. */
  source_tool: SourceTool
  /** Native session identifier from the source tool. */
  source_session_id: string
  /** Canonical project identifier, when recovered. */
  project_id: string | null
  /** Parent session identifier for subagent sessions. */
  parent_session_id: string | null
  /** SQLite boolean indicating whether this session is a subagent. */
  is_subagent: 0 | 1
  /** Source-specific role for a subagent. */
  agent_role: string | null
  /** Display nickname for a subagent. */
  agent_nickname: string | null
  /** Best recovered session title. */
  title: string | null
  /** Best recovered session summary. */
  summary: string | null
  /** Earliest recovered session timestamp. */
  start_ts: string | null
  /** Latest recovered session timestamp. */
  end_ts: string | null
  /** Initial working directory, when available. */
  cwd_initial: string | null
  /** Initial git branch, when available. */
  git_branch_initial: string | null
  /** First observed model name. */
  model_first: string | null
  /** Last observed model name. */
  model_last: string | null
  /** Source or importer session status. */
  status: string | null
  /** Confidence in recovered timeline ordering. */
  timeline_confidence: Confidence
  /** Raw record that introduced the session, when applicable. */
  raw_record_id: string | null
}
