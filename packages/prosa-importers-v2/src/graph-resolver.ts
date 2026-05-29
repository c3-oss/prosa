// GraphResolver: pre-seal pass that walks pending `spawned` edges and
// fills in `SessionV2.parent_session_id` when the parent exists in the
// current epoch.
//
// Cross-epoch case (lane doc): emit `SessionFixupV2` when the parent
// resolves only via a prior epoch. Lane 1's bundle layer does NOT yet
// expose a prior-epoch session inventory — current-epoch policy is in
// effect (CQ-033). Importers that intentionally reference a prior-epoch
// parent must restage it; otherwise `parent_resolution` is left as
// `'unresolved'` and a SessionFixupV2 is queued for the next epoch's
// reconciliation pass.

import type { EdgeV2, SessionFixupV2, SessionV2 } from '@c3-oss/prosa-types-v2'

export type PriorEpochSessionInventory = {
  /** Returns `true` if a session with the given id exists in any sealed epoch. */
  hasSession(sessionId: string): boolean
  /** Sealed-epoch session ids with `parent_resolution='unresolved'` that
   * may now have a discovered parent via `currentEpochEdges`. */
  pendingFixupTargets(): Iterable<string>
}

export type LateBindingIndex = {
  sessionsSeenThisEpoch: Set<string>
  /** Sessions seen in earlier sealed epochs (current-epoch policy: empty). */
  sessionsSeenPriorEpochs: PriorEpochSessionInventory | null
  /** edge_type='spawned', dst_type='session'. */
  spawnedEdges: EdgeV2[]
}

export function buildLateBindingIndex(args: {
  sessions: readonly SessionV2[]
  edges: readonly EdgeV2[]
  priorEpochs?: PriorEpochSessionInventory | null
}): LateBindingIndex {
  const seen = new Set<string>()
  for (const s of args.sessions) seen.add(s.session_id)
  const spawned = args.edges.filter((e) => e.edge_type === 'spawned' && e.dst_type === 'session')
  return {
    sessionsSeenThisEpoch: seen,
    sessionsSeenPriorEpochs: args.priorEpochs ?? null,
    spawnedEdges: spawned,
  }
}

export type ResolveResult = {
  /** Sessions with parent_session_id / parent_resolution populated. */
  resolved: SessionV2[]
  /** SessionFixupV2 entries for cross-epoch references the orchestrator
   * should record on the bundle. Empty under the current-epoch policy. */
  fixups: SessionFixupV2[]
  /** `edge_id`s of `spawned` edges whose `src_id` (the parent session)
   * is missing from BOTH the current epoch's sessions and the prior-epoch
   * inventory. The orchestrator must drop these edges before sealing
   * because `validateFkClosure` enforces strict edge endpoint closure
   * and would otherwise reject the seal. Subagent files orphaned at
   * the source (e.g. Claude's `<sid>/subagents/...` directory present
   * but the parent `<sid>.jsonl` deleted) trigger this; the subagent
   * session itself is preserved with `parent_resolution='unresolved'`. */
  orphanEdgeIds: string[]
}

export function resolveLateBindings(args: {
  sessions: readonly SessionV2[]
  edges: readonly EdgeV2[]
  epoch: number
  createdAt: string
  priorEpochs?: PriorEpochSessionInventory | null
  generateFixupId: () => string
}): ResolveResult {
  const index = buildLateBindingIndex({
    sessions: args.sessions,
    edges: args.edges,
    priorEpochs: args.priorEpochs ?? null,
  })
  const edgeByDst = new Map<string, EdgeV2>()
  for (const e of index.spawnedEdges) {
    if (e.dst_id) edgeByDst.set(e.dst_id, e)
  }

  const resolved: SessionV2[] = []
  const fixups: SessionFixupV2[] = []
  const orphanEdgeIds: string[] = []
  // Walk every spawned edge and decide if its src parent is materialised
  // anywhere reachable from this epoch. Edges with no resolvable parent
  // get reported up so the orchestrator can drop them; otherwise
  // sealEpoch's FK closure walk would reject the seal.
  for (const e of index.spawnedEdges) {
    if (index.sessionsSeenThisEpoch.has(e.src_id)) continue
    if (index.sessionsSeenPriorEpochs?.hasSession(e.src_id)) continue
    orphanEdgeIds.push(e.edge_id)
  }
  for (const session of args.sessions) {
    const next: SessionV2 = { ...session }
    if (next.parent_session_id != null) {
      next.parent_resolution = 'inline'
      resolved.push(next)
      continue
    }
    const edge = edgeByDst.get(next.session_id)
    if (!edge) {
      next.parent_resolution = 'unresolved'
      resolved.push(next)
      continue
    }
    if (index.sessionsSeenThisEpoch.has(edge.src_id)) {
      next.parent_session_id = edge.src_id
      next.parent_resolution = 'edge_derived'
      resolved.push(next)
      continue
    }
    if (index.sessionsSeenPriorEpochs?.hasSession(edge.src_id)) {
      // Cross-epoch parent resolved via the prior-epoch inventory; emit
      // a fixup so the prior-epoch session can later be updated.
      next.parent_session_id = edge.src_id
      next.parent_resolution = 'fixup_derived'
      resolved.push(next)
      fixups.push({
        fixup_id: args.generateFixupId(),
        target_session_id: next.session_id,
        parent_session_id: edge.src_id,
        parent_resolution: 'fixup_derived',
        reason: 'late_parent_edge',
        source_edge_id: edge.edge_id,
        raw_record_id: edge.raw_record_id ?? null,
        epoch: args.epoch,
        created_at: args.createdAt,
      })
      continue
    }
    // Truly unresolved — parent may appear in a later epoch's compile.
    next.parent_resolution = 'unresolved'
    resolved.push(next)
  }

  return { resolved, fixups, orphanEdgeIds }
}
