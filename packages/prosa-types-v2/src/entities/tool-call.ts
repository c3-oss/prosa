export const TOOL_CALL_FIELDS = [
  'tool_call_id',
  'session_id',
  'turn_id',
  'message_id',
  'event_id',
  'source_call_id',
  'tool_name',
  'canonical_tool_type',
  'args_object_id',
  'command',
  'cwd',
  'path',
  'query',
  'timestamp_start',
  'timestamp_end',
  'status',
  'raw_record_id',
] as const

export type ToolCallV2 = {
  tool_call_id: string
  session_id: string
  turn_id: string | null
  message_id: string | null
  event_id: string | null
  source_call_id: string | null
  tool_name: string
  canonical_tool_type: string | null
  args_object_id: string | null
  command: string | null
  cwd: string | null
  path: string | null
  query: string | null
  timestamp_start: string | null
  timestamp_end: string | null
  status: string | null
  raw_record_id: string
}

export const TOOL_CALL_PRIMARY_KEY: keyof ToolCallV2 = 'tool_call_id'
