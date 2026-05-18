# Lane 0 — Foundation

## Goal

Establish the shared type packages, wire schemas, canonical encoding rules, and build/test scaffolding that every other lane depends on. This lane ships **no runtime behavior** — only compile-clean type definitions and canonical-rule documentation that subsequent lanes consume.

The lane exists because Lanes 1–9 will reference these types in dozens of places. If we cut DDL in Lane 4 before fixing the canonical encoding rule in Lane 0, two implementers will produce divergent Merkle leaves and the receipts will not verify.

## Depends on

Nothing. This is the entry point.

## Deliverables

- New package `packages/prosa-types-v2` exporting all canonical entity types (`SessionV2`, `MessageV2`, etc.) and segment / pack / receipt types.
- New package `packages/prosa-wire-v2` exporting Zod schemas for the four-call promotion protocol and `PROTOCOL_VERSION_V2 = 2`.
- One reference doc `packages/prosa-types-v2/CANONICAL.md` pinning the encoding rules.
- Cross-implementation conformance test fixture under
  `test/fixtures/canonical-leaves/` with committed expected Merkle leaves
  (CQ-018: the per-entity leaves are produced by the current TS encoder
  and pinned; the cross-implementation contract is backed by 12
  hand-traceable canonical-CBOR vectors plus 2 BLAKE3 spec test vectors in
  `packages/prosa-types-v2/test/cbor-vectors.test.ts` — an independent
  implementation must reproduce those before reaching the projection-leaf
  fixture).
- CI pipeline updated to run typecheck + test on the new packages.

## Tasks

1. **Create `packages/prosa-types-v2`** with the canonical entity schema from `docs/rearch/14-proposal-2.md` lines 847–1068, plus `SegmentRef`, `PackRef`, `BundleHeadV2`, `LogicalImportUnit`, `SourceStateV2`, `RawSourcePackEntryV2`, `SessionFixupV2` (lean: only `parent_session_id` + `parent_resolution`), `PromotionReceiptV2`.
2. **Create `packages/prosa-wire-v2`** with Zod schemas: `BeginPromotionRequest/Response`, `UploadSegmentRequest`, `UploadObjectPackHeader`, `SealPromotionRequest/Response`, `GetReceiptRequest/Response`. Export the constant `PROTOCOL_VERSION_V2 = 2`.
3. **Write `packages/prosa-types-v2/CANONICAL.md`** pinning the encoding rules (see "Concrete types and schemas" below).
4. **Implement `packages/prosa-types-v2/src/canonical.ts`** with `canonicalCbor`, `merkleLeaf`, `merkleRoot` exported as pure functions. Take an arbitrary entity row tuple and produce the 32-byte BLAKE3 leaf.
5. **Write the conformance test fixture** at
   `test/fixtures/canonical-leaves/*.json` with committed expected leaves
   for one row of each entity type — produced by the TS encoder and
   pinned as the regression contract. Add `test/conformance/leaves.test.ts`
   that loads the fixture and asserts equality. Add
   `packages/prosa-types-v2/test/cbor-vectors.test.ts` with 12+
   hand-traceable canonical-CBOR byte vectors and 2 BLAKE3 spec test
   vectors so the cross-implementation contract is actually independent
   (CQ-018).
6. **Update CI** (`.github/workflows/ci.yml`, or equivalent) to run typecheck and test on the new packages on every PR.

Each task is roughly one PR.

## Concrete types and schemas

### Canonical encoding rules (pinned, no implementer drift allowed)

The normative rules live in `packages/prosa-types-v2/CANONICAL.md` and the
implementation in `packages/prosa-types-v2/src/canonical.ts`. CQ-030
removed the previous duplicated excerpt from this file so that a second
implementer following the lane doc cannot inadvertently diverge from the
canonical spec — every rule, including the semantic UTC timestamp check
(CQ-014) and the exact ID regex `^[a-z0-9][a-z0-9_:-]*$` (CQ-022), is
defined exactly once.

Summary (non-normative — read CANONICAL.md for the binding text):

- Rule 1 — Field order: per `*_FIELDS` declared in
  `packages/prosa-types-v2/src/entities/<name>.ts`.
- Rule 2 — Null: CBOR `0xf6`; missing optional fields encode as null.
- Rule 3 — Integers: canonical CBOR smallest representation.
- Rule 4 — Strings: UTF-8 NFC.
- Rule 5 — Timestamps: `YYYY-MM-DDTHH:MM:SS.sssZ`, **semantic UTC
  validity required** (must round-trip via `Date.UTC`).
- Rule 6 — Identifiers + hashes: exact ID regex
  `^[a-z0-9][a-z0-9_:-]*$`; tagged-hash form `blake3:<64-hex-lower>`
  where the named kind is tagged; bare 64-hex for `bundleRoot`,
  `rawSourceRoot`, `objectSetRoot`. `manifestDigest` is tagged.
- Rule 7 — Sort order: bytewise ASC on primary key within an entity;
  alphabetical across `CanonicalEntityType`.
- Rule 8 — Leaf: `blake3('prosa.projection.leaf.v2' || entity_type ||
  primary_key || canonical_cbor(row))`.
- Rule 9 — Tree: binary Merkle, BLAKE3 inner nodes, odd leaves duplicated,
  empty subtree = 32 zero bytes.
- Rule 10 — `bundleRoot`: cross-entity canonical projection Merkle root.
- Rule 11 — `rawSourceRoot`: blake3 over the sorted raw-source pack
  entries with leaf domain `prosa.rawsource.leaf.v2`.
- Rule 12 — Receipt payload bytes + `deriveReceiptId` zeroing.
- Rule 13 — `source_file_id` and `raw_record_id` deterministic
  derivation.

The conformance test at `test/conformance/leaves.test.ts` is the
regression contract; the hand-traceable cross-implementation contract
lives in `packages/prosa-types-v2/test/cbor-vectors.test.ts` (CQ-018).
Any drift in either fails CI.

### `SessionFixupV2` (lean shape)

```ts
// packages/prosa-types-v2/src/entities/session-fixup.ts
export type SessionFixupV2 = {
  fixup_id: string
  target_session_id: string
  parent_session_id: string | null
  parent_resolution:
    | 'inline'
    | 'edge_derived'
    | 'fixup_derived'
    | 'unresolved'
  reason: 'late_parent_edge' | 'provider_reprojection'
  source_edge_id: string | null
  raw_record_id: string | null
  epoch: number
  created_at: string
}
```

The closeout's wider 7-field fixup is **not** implemented in v2.0. If a real-world case for `end_ts` / `model_last` cross-epoch fixup emerges in production, extend in v2.1.

### `BundleHeadV2` (lean shape with two Merkle roots)

```ts
// packages/prosa-types-v2/src/bundle.ts
export type BundleHeadV2 = {
  bundleFormat: 2
  storeId: string                  // stable UUID for the logical local store
  storePath: string                // informational
  epoch: number
  parserVersion: string
  createdAt: string
  previousBundleRoot: string | null

  // Lean: two Merkle roots, not six.
  // CQ-021: `bundleRoot` is the cross-entity canonical projection Merkle
  // root (CANONICAL.md rule 10) — NOT a Merkle root over the manifest
  // bytes. The manifest's own content address is `manifestDigest` (the
  // separate tagged BLAKE3 digest on the line below).
  bundleRoot: string               // cross-entity canonical projection Merkle root
  // BLAKE3 over the manifest's serialized bytes (tagged form). Distinct
  // from `bundleRoot`; changing segments or pack ordering changes this
  // digest without changing `bundleRoot` when canonical projection rows
  // are unchanged.
  manifestDigest: string           // 'blake3:<hex>'
  rawSourceRoot: string            // Merkle root over preserved source-file bytes

  counts: {
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

  segments: SegmentRef[]
}
```

### `PromotionReceiptV2` (lean shape)

```ts
// packages/prosa-types-v2/src/receipt.ts
export type PromotionReceiptV2Payload = {
  receiptVersion: 2
  receiptId: string                    // 'rcpt_<base32(blake3(payload_without_sig))>'
  protocolVersion: 2

  tenantId: string
  storeId: string
  storePath: string
  deviceId: string                     // deviceKeyId / publicKey deferred to v2.x

  issuedAt: string
  serverRegion: string
  serverKeyId: string

  previousReceiptId: string | null
  previousBundleRoot: string | null

  // Lean: two roots only.
  bundleRoot: string
  rawSourceRoot: string

  counts: BundleHeadV2['counts']

  materialization: {
    postgresCommitId: string           // pg_lsn at seal time
    searchGenerationId: string         // generation pointer for Tantivy local; Postgres FTS uses Postgres LSN
    rowCountsByEntity: Record<CanonicalEntityType, number>
  }

  verification: {
    uploadDigestVerified: true
    objectHashesVerifiedAtIngest: true
    projectionRowsLoaded: true
    noPerObjectHeadRequired: true
    backgroundAuditEligible: true
  }

  clientSignatureStatus: 'absent_v2_0'  // v2.0 has server signing only
}

export type PromotionReceiptV2 = {
  payload: PromotionReceiptV2Payload
  signature: {
    alg: 'Ed25519'
    keyId: string
    sig: string                        // base64url
  }
}
```

### Wire schemas (Zod)

```ts
// packages/prosa-wire-v2/src/schemas.ts
import { z } from 'zod'

export const PROTOCOL_VERSION_V2 = 2 as const

export const beginPromotionRequestSchema = z.object({
  protocolVersion: z.literal(2),
  tenantId: z.string(),
  storeId: z.string(),
  storePath: z.string(),
  head: bundleHeadV2Schema,
  inventories: z.object({
    objectInventorySegment: segmentRefSchema,
    projectionInventorySegment: segmentRefSchema,
  }),
  // device.publicKey and clientSignature deferred to v2.x
  device: z.object({
    deviceId: z.string(),
  }),
})

export const beginPromotionResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('already_promoted'), receipt: promotionReceiptV2Schema }),
  z.object({
    status: z.literal('needs_inventory'),
    promotionId: z.string(),
    missingInventories: z.array(segmentRefSchema),
  }),
  z.object({
    status: z.literal('needs_upload'),
    promotionId: z.string(),
    missingSegments: z.array(segmentRefSchema),
    missingObjects: missingObjectPlanV2Schema,
  }),
])

// ... uploadSegment, uploadObjectPack, sealPromotion, getReceipt follow the same pattern
```

## Tests

| File | Asserts |
|---|---|
| `packages/prosa-types-v2/test/canonical-encoding.test.ts` | Each rule from `CANONICAL.md` holds. Truncation (not rounding). NFC. CBOR canonical form. |
| `packages/prosa-types-v2/test/merkle-leaf.test.ts` | `merkleLeaf(entityType, row)` is deterministic and byte-stable. |
| `packages/prosa-types-v2/test/merkle-root.test.ts` | Binary Merkle tree construction. Odd-leaf duplication. Empty subtree = 32 zero bytes. |
| `test/conformance/leaves.test.ts` | Loads fixtures from `test/fixtures/canonical-leaves/*.json` (committed regression contract; see CQ-018). Asserts every fixture matches. The independent cross-implementation drift catcher lives in `packages/prosa-types-v2/test/cbor-vectors.test.ts` (hand-traceable CBOR vectors + BLAKE3 spec vectors). |
| `packages/prosa-wire-v2/test/schemas.test.ts` | Every Zod schema parses fixture payloads round-trip. Rejects malformed payloads with specific error codes. |

## Gate

The lane is complete when **all** of the following hold:

1. `pnpm typecheck` clean across `packages/prosa-types-v2` and `packages/prosa-wire-v2`.
2. `pnpm test --filter @prosa/types-v2 --filter @prosa/wire-v2` passes.
3. `test/conformance/leaves.test.ts` passes against at least one committed fixture per entity type (13 entity types total), AND `packages/prosa-types-v2/test/cbor-vectors.test.ts` passes with hand-traceable CBOR + BLAKE3 spec vectors (CQ-018).
4. No production code in `apps/` or other `packages/` imports from `prosa-types-v2` or `prosa-wire-v2` yet. (This lane only ships types; consumers come in later lanes.)
5. CI configured to run typecheck + test on these packages on every PR going forward.

## Risks

| Risk | Mitigation |
|---|---|
| Implementer drift on canonical encoding | The conformance test is the gate. Any future change to encoding requires fixture regeneration AND a Lane 0 ADR. |
| `SessionFixupV2` extension creep | The type intentionally has only `parent_session_id`/`parent_resolution`. Adding fields requires an ADR documenting the observed cross-epoch case. |
| Two Merkle roots feel "too few" | Document the trade-off in `CANONICAL.md`. Other sub-roots are computed internally for validation but not signed. |

## Unblocks

Lane 1 (`02-lane-1-local-store.md`) — needs `BundleHeadV2`, `SegmentRef`, `PackRef`, `SourceStateV2` to start.
