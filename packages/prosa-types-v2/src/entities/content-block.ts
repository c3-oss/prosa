import type { Visibility } from '../common.js'

export const CONTENT_BLOCK_FIELDS = [
  'block_id',
  'message_id',
  'event_id',
  'session_id',
  'ordinal',
  'block_type',
  'text_object_id',
  'text_inline',
  'mime_type',
  'token_count',
  'is_error',
  'is_redacted',
  'visibility',
  'raw_record_id',
] as const

export type ContentBlockV2 = {
  block_id: string
  message_id: string | null
  event_id: string | null
  session_id: string
  ordinal: number
  block_type: string
  text_object_id: string | null
  text_inline: string | null
  mime_type: string | null
  token_count: number | null
  is_error: boolean
  is_redacted: boolean
  visibility: Visibility
  raw_record_id: string
}

export const CONTENT_BLOCK_PRIMARY_KEY: keyof ContentBlockV2 = 'block_id'
