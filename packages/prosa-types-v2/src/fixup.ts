import type { ParentResolution } from './entities/session.js'

// Lean shape: only parent_session_id + parent_resolution. Adding fields
// requires an ADR documenting an observed cross-epoch case (see
// docs/rearch-2/01-lane-0-foundation.md Risks).
export type SessionFixupV2 = {
  fixup_id: string
  target_session_id: string
  parent_session_id: string | null
  parent_resolution: ParentResolution
  reason: 'late_parent_edge' | 'provider_reprojection'
  source_edge_id: string | null
  raw_record_id: string | null
  epoch: number
  created_at: string
}
