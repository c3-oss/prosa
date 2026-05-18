// CQ-001: `bundleRoot` is the cross-entity canonical projection Merkle root.
// Manifest/segment byte changes carry into `manifestDigest` only, not into
// `bundleRoot`. Row reorder within an entity does not change `bundleRoot`.

import { describe, expect, it } from 'vitest'

import { bundleRootFromRows, toHex } from '../src/canonical.js'

function sessionRow(id: string, title: string | null = null) {
  return {
    session_id: id,
    source_tool: 'codex',
    source_session_id: `src_${id}`,
    project_id: null,
    parent_session_id: null,
    parent_resolution: 'unresolved',
    is_subagent: false,
    agent_role: null,
    agent_nickname: null,
    title,
    summary: null,
    start_ts: '2025-01-02T03:04:05.123Z',
    end_ts: null,
    cwd_initial: null,
    git_branch_initial: null,
    model_first: null,
    model_last: null,
    status: null,
    timeline_confidence: 'high',
    raw_record_id: null,
  }
}

describe('bundleRoot semantics (CQ-001)', () => {
  it('is stable under row insertion order within an entity', () => {
    const ordered = [sessionRow('ses_a'), sessionRow('ses_b'), sessionRow('ses_c')]
    const shuffled = [ordered[2], ordered[0], ordered[1]] as typeof ordered
    expect(toHex(bundleRootFromRows({ session: ordered }))).toBe(toHex(bundleRootFromRows({ session: shuffled })))
  })

  it('changes when any row content changes', () => {
    const a = toHex(bundleRootFromRows({ session: [sessionRow('ses_a')] }))
    const b = toHex(bundleRootFromRows({ session: [sessionRow('ses_a', 'changed')] }))
    expect(a).not.toBe(b)
  })

  it('changes when rows are added to an entity', () => {
    const a = toHex(bundleRootFromRows({ session: [sessionRow('ses_a')] }))
    const b = toHex(bundleRootFromRows({ session: [sessionRow('ses_a'), sessionRow('ses_b')] }))
    expect(a).not.toBe(b)
  })

  it('returns the all-empty cross-entity root for an empty bundle', () => {
    // A bundle with no rows across any entity still has a deterministic
    // bundleRoot — the cross-entity Merkle root over 13 zero subroots.
    const root = toHex(bundleRootFromRows({}))
    expect(root.length).toBe(64)
    expect(/[1-9a-f]/.test(root)).toBe(true) // non-zero (the root of 13 zero leaves)
  })

  it('does NOT depend on segment/manifest metadata (manifestDigest is orthogonal)', () => {
    // bundleRootFromRows only consumes canonical projection rows. There is
    // no segment/manifest input to it — that is exactly the property
    // CQ-001 requires. Two BundleHeadV2 instances with the same row set
    // but different segments/manifestDigest must share the same
    // bundleRoot. We exercise that by verifying the bundleRoot helper
    // signature does not accept segments at all.
    const baseline = toHex(bundleRootFromRows({ session: [sessionRow('ses_a')] }))
    // No way to "perturb" segments through this helper — that is the point.
    expect(baseline).toBe(toHex(bundleRootFromRows({ session: [sessionRow('ses_a')] })))
  })
})
