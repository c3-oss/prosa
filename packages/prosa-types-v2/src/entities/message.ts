import type { MessageRole } from '../common.js'

export const MESSAGE_FIELDS = [
  'message_id',
  'session_id',
  'turn_id',
  'event_id',
  'source_message_id',
  'role',
  'author_name',
  'model',
  'timestamp',
  'ordinal',
  'parent_message_id',
  'request_id',
  'status',
  'raw_record_id',
] as const

export type MessageV2 = {
  message_id: string
  session_id: string
  turn_id: string | null
  event_id: string | null
  source_message_id: string | null
  role: MessageRole
  author_name: string | null
  model: string | null
  timestamp: string | null
  ordinal: number
  parent_message_id: string | null
  request_id: string | null
  status: string | null
  raw_record_id: string
}

export const MESSAGE_PRIMARY_KEY: keyof MessageV2 = 'message_id'
