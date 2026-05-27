export const TOOL_RESULT_FIELDS = [
  'tool_result_id',
  'tool_call_id',
  'session_id',
  'message_id',
  'event_id',
  'source_call_id',
  'status',
  'is_error',
  'exit_code',
  'duration_ms',
  'stdout_object_id',
  'stderr_object_id',
  'output_object_id',
  'preview',
  'raw_record_id',
] as const

export type ToolResultV2 = {
  tool_result_id: string
  tool_call_id: string | null
  session_id: string
  message_id: string | null
  event_id: string | null
  source_call_id: string | null
  status: string | null
  is_error: boolean
  exit_code: number | null
  duration_ms: number | null
  stdout_object_id: string | null
  stderr_object_id: string | null
  output_object_id: string | null
  preview: string | null
  raw_record_id: string
}

export const TOOL_RESULT_PRIMARY_KEY: keyof ToolResultV2 = 'tool_result_id'
