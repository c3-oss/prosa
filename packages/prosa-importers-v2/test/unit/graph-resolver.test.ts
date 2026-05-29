import { describe, expect, it } from 'vitest'

import { resolveLateBindings } from '../../src/graph-resolver.js'

function sess(id: string, parent: string | null = null): import('@c3-oss/prosa-types-v2').SessionV2 {
  return {
    session_id: id,
    source_tool: 'codex',
    source_session_id: `src_${id}`,
    project_id: null,
    parent_session_id: parent,
    parent_resolution: 'unresolved',
    is_subagent: false,
    agent_role: null,
    agent_nickname: null,
    title: null,
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

function spawnEdge(id: string, src: string, dst: string): import('@c3-oss/prosa-types-v2').EdgeV2 {
  return {
    edge_id: id,
    src_type: 'session',
    src_id: src,
    dst_type: 'session',
    dst_id: dst,
    edge_type: 'spawned',
    confidence: 'high',
    source: 'explicit',
    raw_record_id: null,
    metadata_object_id: null,
  }
}

describe('resolveLateBindings', () => {
  it('sets parent_resolution=inline when parent_session_id is already populated', () => {
    const r = resolveLateBindings({
      sessions: [sess('ses_b', 'ses_a')],
      edges: [],
      epoch: 1,
      createdAt: '2025-01-02T03:04:05.123Z',
      generateFixupId: () => 'fix_0',
    })
    expect(r.resolved[0]?.parent_resolution).toBe('inline')
    expect(r.resolved[0]?.parent_session_id).toBe('ses_a')
    expect(r.fixups.length).toBe(0)
    expect(r.orphanEdgeIds).toEqual([])
  })

  it('sets parent_resolution=edge_derived when the parent is in the same epoch', () => {
    const r = resolveLateBindings({
      sessions: [sess('ses_a'), sess('ses_b')],
      edges: [spawnEdge('edg_1', 'ses_a', 'ses_b')],
      epoch: 1,
      createdAt: '2025-01-02T03:04:05.123Z',
      generateFixupId: () => 'fix_0',
    })
    const b = r.resolved.find((s) => s.session_id === 'ses_b')!
    expect(b.parent_resolution).toBe('edge_derived')
    expect(b.parent_session_id).toBe('ses_a')
    expect(r.fixups.length).toBe(0)
  })

  it('leaves parent_resolution=unresolved when no edge points at the child', () => {
    const r = resolveLateBindings({
      sessions: [sess('ses_b')],
      edges: [],
      epoch: 1,
      createdAt: '2025-01-02T03:04:05.123Z',
      generateFixupId: () => 'fix_0',
    })
    expect(r.resolved[0]?.parent_resolution).toBe('unresolved')
    expect(r.resolved[0]?.parent_session_id).toBe(null)
  })

  it('emits SessionFixupV2 for cross-epoch parents via the prior-epoch inventory', () => {
    const r = resolveLateBindings({
      sessions: [sess('ses_child')],
      edges: [spawnEdge('edg_1', 'ses_prior_parent', 'ses_child')],
      epoch: 2,
      createdAt: '2025-01-02T03:04:05.123Z',
      priorEpochs: {
        hasSession: (id) => id === 'ses_prior_parent',
        pendingFixupTargets: () => [],
      },
      generateFixupId: () => 'fix_xyz',
    })
    const child = r.resolved[0]!
    expect(child.parent_resolution).toBe('fixup_derived')
    expect(child.parent_session_id).toBe('ses_prior_parent')
    expect(r.fixups.length).toBe(1)
    expect(r.fixups[0]?.target_session_id).toBe('ses_child')
    expect(r.fixups[0]?.parent_session_id).toBe('ses_prior_parent')
    expect(r.fixups[0]?.reason).toBe('late_parent_edge')
  })

  it('leaves unresolved when an edge points at a parent missing from both epochs (current-epoch policy)', () => {
    const r = resolveLateBindings({
      sessions: [sess('ses_child')],
      edges: [spawnEdge('edg_1', 'ses_missing', 'ses_child')],
      epoch: 1,
      createdAt: '2025-01-02T03:04:05.123Z',
      generateFixupId: () => 'fix_0',
    })
    expect(r.resolved[0]?.parent_resolution).toBe('unresolved')
    expect(r.resolved[0]?.parent_session_id).toBe(null)
    expect(r.fixups.length).toBe(0)
    expect(r.orphanEdgeIds).toEqual(['edg_1'])
  })

  it('does not flag the edge as orphan when the parent is in the current epoch', () => {
    const r = resolveLateBindings({
      sessions: [sess('ses_a'), sess('ses_b')],
      edges: [spawnEdge('edg_1', 'ses_a', 'ses_b')],
      epoch: 1,
      createdAt: '2025-01-02T03:04:05.123Z',
      generateFixupId: () => 'fix_0',
    })
    expect(r.orphanEdgeIds).toEqual([])
  })

  it('does not flag the edge as orphan when the parent resolves via prior epochs', () => {
    const r = resolveLateBindings({
      sessions: [sess('ses_child')],
      edges: [spawnEdge('edg_1', 'ses_prior_parent', 'ses_child')],
      epoch: 2,
      createdAt: '2025-01-02T03:04:05.123Z',
      priorEpochs: {
        hasSession: (id) => id === 'ses_prior_parent',
        pendingFixupTargets: () => [],
      },
      generateFixupId: () => 'fix_xyz',
    })
    expect(r.orphanEdgeIds).toEqual([])
  })

  it('reports every orphan spawned edge when multiple parents are missing', () => {
    const r = resolveLateBindings({
      sessions: [sess('ses_child1'), sess('ses_child2')],
      edges: [spawnEdge('edg_1', 'ses_missing_a', 'ses_child1'), spawnEdge('edg_2', 'ses_missing_b', 'ses_child2')],
      epoch: 1,
      createdAt: '2025-01-02T03:04:05.123Z',
      generateFixupId: () => 'fix_0',
    })
    expect(new Set(r.orphanEdgeIds)).toEqual(new Set(['edg_1', 'edg_2']))
  })
})
