import type { SegmentRef } from './segment.js'

export type BundleCountsV2 = {
  sourceFiles: number
  rawRecords: number
  objects: number
  sessions: number
  turns: number
  events: number
  messages: number
  contentBlocks: number
  toolCalls: number
  toolResults: number
  artifacts: number
  edges: number
  searchDocs: number
  projectionRows: number
}

export type BundleHeadV2 = {
  bundleFormat: 2
  storeId: string
  storePath: string
  epoch: number
  parserVersion: string
  createdAt: string
  previousBundleRoot: string | null

  // Lean profile: two roots only — the canonical projection root
  // (cross-entity, CANONICAL.md rule 10) and the raw-source root
  // (CANONICAL.md rule 11). The manifest's serialized byte digest is carried
  // separately as `manifestDigest`; it is informational/local and is not the
  // remote-authority key.
  bundleRoot: string
  rawSourceRoot: string

  // BLAKE3 over the canonical serialized manifest bytes. Tagged-hash form
  // (`blake3:<hex>`). Distinct from `bundleRoot`: changing segments or
  // pack-manifest ordering changes this digest without changing
  // `bundleRoot` when canonical projection rows are unchanged.
  manifestDigest: string

  counts: BundleCountsV2

  segments: SegmentRef[]
}
