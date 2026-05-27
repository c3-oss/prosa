export const TURN_FIELDS = [
  'turn_id',
  'session_id',
  'source_turn_id',
  'ordinal',
  'start_ts',
  'end_ts',
  'model',
  'cwd',
  'git_branch',
  'approval_policy',
  'sandbox_policy',
  'effort',
  'raw_record_id',
] as const

export type TurnV2 = {
  turn_id: string
  session_id: string
  source_turn_id: string | null
  ordinal: number
  start_ts: string | null
  end_ts: string | null
  model: string | null
  cwd: string | null
  git_branch: string | null
  approval_policy: string | null
  sandbox_policy: string | null
  effort: string | null
  raw_record_id: string | null
}

export const TURN_PRIMARY_KEY: keyof TurnV2 = 'turn_id'
