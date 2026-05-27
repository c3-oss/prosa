// Derived-layer snapshot — the one-call bulk read for downstream
// dashboards and MCP servers.
//
// Operators (and the agents that proxy for them) routinely want
// the answer to four questions at once:
//
//   1. What is the bundle's current state? — `maintenance`
//   2. What should I do next? — `recommendations`
//   3. How much disk does it use? — `footprint`
//   4. What does this binary support? — `capabilities`
//
// `derivedLayerSnapshot` runs all four in parallel via Promise.all
// and emits one combined object. The shape pivots on the four
// existing sub-shapes (no aggregation, no renaming) so each field
// stays interpretable against its own primitive's docs and tests.
//
// Pure-read: every component is pure-read. No clock, no writes,
// no side effects. Symlink containment is inherited from the
// underlying primitives (CQ-094/CQ-098/CQ-112 parallels).

import { type DerivedLayerCapabilities, derivedLayerCapabilities } from './capabilities.js'
import { type DerivedLayerFootprint, summariseDerivedLayerFootprint } from './footprint.js'
import { type DerivedLayerMaintenanceSummary, derivedLayerMaintenanceSummary } from './maintenance.js'
import { type DerivedLayerRecommendation, recommendMaintenanceActions } from './recommendations.js'

export interface DerivedLayerSnapshot {
  /** Descriptive state — what the bundle looks like right now. */
  maintenance: DerivedLayerMaintenanceSummary
  /** Prescriptive guidance — the ordered list of recommended next
   *  actions derived from `maintenance`. `[]` when idle. */
  recommendations: DerivedLayerRecommendation[]
  /** Disk footprint of the `derived/` subtree, per subsystem. */
  footprint: DerivedLayerFootprint
  /** Pure introspection — schema discriminators, compaction
   *  policy, analytics views, tantivy schema. */
  capabilities: DerivedLayerCapabilities
}

/**
 * Compose the maintenance summary, recommendations, footprint, and
 * capabilities into one snapshot. Each sub-read runs in parallel.
 *
 * The recommendations layer reads from the same maintenance
 * summary produced here, not a re-fetched one, so the snapshot is
 * internally coherent (recommendations match the surfaced state).
 *
 * Empty bundles return zero-state shapes per sub-component.
 */
export async function derivedLayerSnapshot(bundleRoot: string): Promise<DerivedLayerSnapshot> {
  const [maintenance, footprint] = await Promise.all([
    derivedLayerMaintenanceSummary(bundleRoot),
    summariseDerivedLayerFootprint(bundleRoot),
  ])
  const recommendations = recommendMaintenanceActions(maintenance)
  const capabilities = derivedLayerCapabilities()
  return { maintenance, recommendations, footprint, capabilities }
}
