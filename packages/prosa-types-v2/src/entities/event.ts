import type { Actor, Confidence } from '../common.js'

export const EVENT_FIELDS = [
  'event_id',
  'session_id',
  'turn_id',
  'source_event_id',
  'event_type',
  'source_type',
  'subtype',
  'timestamp',
  'ordinal',
  'actor',
  'payload_object_id',
  'raw_record_id',
  'confidence',
  'is_derived',
] as const

export type EventV2 = {
  event_id: string
  session_id: string
  turn_id: string | null
  source_event_id: string | null
  event_type: string
  source_type: string | null
  subtype: string | null
  timestamp: string | null
  ordinal: number
  actor: Actor | null
  payload_object_id: string | null
  raw_record_id: string
  confidence: Confidence
  is_derived: boolean
}

export const EVENT_PRIMARY_KEY: keyof EventV2 = 'event_id'
