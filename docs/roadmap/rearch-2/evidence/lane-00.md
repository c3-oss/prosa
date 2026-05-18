# Lane Evidence

Lane: 00 - Foundation
Status: complete (Lane 0 integrity corrections CQ-001..CQ-019 all
closed; Codex's Lane 1 re-review is the gating action for the final
Lane 0/1 acceptance via CQ-044).
Owner: Ralph
Commit range: `cd845f2`, `e22ec27`, `b78b5ae`, `70b9df0`, `0e8a912`,
`a650ef8`, `2809d21` (Lane 0 hardening chain through CQ-001..CQ-019;
later Lane 1 commits also touch `packages/prosa-types-v2/CANONICAL.md`
governance text per CQ-036 / CQ-052 / CQ-055).

## Acceptance Criteria

- [x] `packages/prosa-types-v2` exports canonical entity, segment, pack,
  bundle head, logical import, source state, raw pack entry, session fixup,
  receipt types, plus the canonical encoder, Merkle helpers,
  `rawSourceLeaf`/`rawSourceRootFromEntries`, `receiptPayloadBytes`/
  `deriveReceiptId`, and `deriveSourceFileId`/`deriveRawRecordId`.
- [x] `packages/prosa-wire-v2` exports Zod schemas for the v2 promotion
  protocol and `PROTOCOL_VERSION_V2 = 2`, with named hash-kind aliases
  (`objectIdSchema`, `storedHashSchema`, `packDigestSchema`,
  `objectSetRootSchema`, `bundleRootSchema`, `rawSourceRootSchema`,
  `manifestDigestSchema`) and canonical id / timestamp schemas (CQ-004,
  CQ-002).
- [x] `packages/prosa-types-v2/CANONICAL.md` pins canonical encoding rules
  (13 rules covering bundleRoot, rawSourceRoot, receipt payload, idempotency
  keys, and the conformance fixture's authority).
- [x] Canonical helpers are pure and tested.
- [x] Conformance fixture covers all 13 canonical entity types in
  `test/fixtures/canonical-leaves/{rows,expected-leaves}.json`. Test asserts
  byte-for-byte equality.
- [x] CI configured to run typecheck + test on the new packages on every
  PR (`.github/workflows/ci.yml`).
- [x] No production code in `apps/` or other `packages/` imports
  `@c3-oss/prosa-types-v2` or `@c3-oss/prosa-wire-v2` yet (only the new
  packages and root test/conformance use them).
- [x] Workspace `pnpm build`, `just typecheck`, `just test-all`, and
  `just lint-all` all green (9/9 packages each); `pnpm test:conformance`
  green; `git diff --check` clean.

## Implementation Notes

- Source contract: `docs/rearch-2/01-lane-0-foundation.md` plus
  `docs/roadmap/rearch-2/correction-queue.md` (closed CQ-001…CQ-009).
- Lean profile: two signed roots (`bundleRoot`, `rawSourceRoot`) plus a
  local `manifestDigest`.
- `bundleRoot` is **the cross-entity canonical projection Merkle root**
  (CANONICAL.md rule 10). It is independent of segment / manifest layout.
- `rawSourceRoot` is computed via `rawSourceRootFromEntries()` with leaf
  domain `prosa.rawsource.leaf.v2` and sort by `source_file_id` ASC
  (CANONICAL.md rule 11).
- `merkleLeaf` validates every declared field against its `FieldKind`
  before encoding. Timestamps, ids, tagged/bare hashes, booleans, and
  integers each have an explicit canonical regex / type check (CQ-002).
- `receiptPayloadBytes` encodes nested `counts` / `materialization` /
  `verification` as fixed-order arrays; `rowCountsByEntity` is the
  `CANONICAL_ENTITY_TYPES`-ordered integer array (CQ-005).
- `deriveSourceFileId` and `deriveRawRecordId` give deterministic
  idempotency keys; `RawRecordV2` carries the locator and provenance
  fields needed for byte-for-byte reproject (CQ-006).
- The expected-leaves.json fixture IS the cross-implementation contract.
  `generate-expected.ts` is documented as a non-authoritative helper;
  regeneration requires an ADR. CI is configured to never auto-update it
  (CQ-008).
- `mtime_ns` in the source-file fixture is `null` — nanoseconds since
  epoch overflows `Number.MAX_SAFE_INTEGER`. Lane 1 must widen the type
  to `bigint | null` before importers populate it from filesystem stats.

## Commands Run

Latest focused gates at HEAD `1e81888` (post Lane 0 CQ-001..CQ-019 +
Lane 1 hardening chain through CQ-053..CQ-055):

```text
# Per-package
pnpm --filter @c3-oss/prosa-types-v2 typecheck      # clean
pnpm --filter @c3-oss/prosa-types-v2 test           # 89 tests, 8 files
pnpm --filter @c3-oss/prosa-types-v2 build          # dist/ emitted
pnpm --filter @c3-oss/prosa-types-v2 lint           # clean
pnpm --filter @c3-oss/prosa-wire-v2 typecheck       # clean
pnpm --filter @c3-oss/prosa-wire-v2 test            # 21 tests pass
pnpm --filter @c3-oss/prosa-wire-v2 build           # dist/ emitted
pnpm --filter @c3-oss/prosa-wire-v2 lint            # clean

# Workspace gates (12 packages: Lane 0 + Lane 1 + out-of-sequence Lane 2/4 WIP)
pnpm install --frozen-lockfile                       # clean
pnpm build                                            # 12/12 turbo (FULL TURBO)
pnpm typecheck                                        # 12/12 turbo
pnpm test                                             # 12/12 turbo
pnpm lint                                             # 12/12 turbo
pnpm test:conformance                                 # 15 tests pass
pnpm audit --audit-level moderate                     # 8 findings classified in gates.md
git diff --check                                      # clean

# CQ artifacts
pnpm generate:canonical-fixture                       # non-authoritative helper
```

Lane 0 test count grew from 75 → 89 across the CQ-010..CQ-019
closeout chain (BLAKE3 spec vectors, expanded timestamp/normalization,
extended-field-kind tests). Lane 0 `prosa-wire-v2` grew from 14 → 21
across the same chain (CQ-011 receiptId binding, CQ-012 transportHash,
CQ-017 receipt-id zeroing).

## Data / Security Evidence

- Conformance: `test/conformance/leaves.test.ts` recomputes 13 entity leaves
  and asserts equality against the committed
  `test/fixtures/canonical-leaves/expected-leaves.json`. Any encoder drift
  flips at least one leaf and fails the test.
- bundleRoot: `packages/prosa-types-v2/test/bundle-root.test.ts` proves row
  reorder stability and rules out segment/manifest carryover via the helper
  signature (`bundleRootFromRows` accepts only canonical rows).
- Normalization: `packages/prosa-types-v2/test/normalization.test.ts` —
  non-canonical timestamps, uppercase ids, bare hex masquerading as
  tagged_hash, non-boolean booleans, non-integer integers are all rejected.
- rawSourceRoot: `packages/prosa-types-v2/test/raw-source.test.ts` — every
  byte-identifying field flips the root; sort-order stable; idempotent.
- Receipt: `packages/prosa-types-v2/test/receipt-payload.test.ts` — any
  root/count/materialization field flip changes `deriveReceiptId`;
  rowCountsByEntity is insertion-order independent.
- Idempotency keys: `packages/prosa-types-v2/test/derive-ids.test.ts` —
  determinism, NFC-normalized paths, bigint ordinals, rejection of
  non-canonical inputs.
- BLAKE3 via `@noble/hashes/blake3` (already used elsewhere in the repo).
- `pnpm audit --audit-level moderate`: 7 advisories (1 low, 5 moderate,
  1 high) all on **dev/tooling transitive deps** (`commitizen > lodash`,
  `vitest > vite`, etc.). No runtime production deps. Identical posture
  to `master`; Lane 0 introduces no new transitive risk. Classification
  table in `gates.md`.

## Known Risks

- `mtime_ns` precision (see Implementation Notes) — Lane 1 must decide on
  `bigint | null` widening.
- The conformance fixture is implementation-derived at first commit;
  future implementations must reproduce it byte-for-byte. The independence
  property is documented in CANONICAL.md and
  `test/fixtures/canonical-leaves/README.md`.
- The `vite` advisory is gated by `@c3-oss/config-vitest@0.3.0` peer pin
  to vitest ^3.1.1 while the repo is on 2.1.9. Upgrading vitest is a
  separate workstream tracked outside this lane.

## Reviewer Notes

- `prosa-architect` and `ralph-loop-promotion-integrity-reviewer` raised
  CQ-001…CQ-008 on 2026-05-18; CQ-009 added by Codex re-review.
- Codex final re-review after `cd845f2`/`e22ec27` opened CQ-010 through
  CQ-015. This iteration closed all six:
  - CQ-010 — every CAS object reference field in `ENTITY_FIELD_KINDS` is
    now `tagged_hash`; fixture rows updated; `expected-leaves.json`
    regenerated; tests reject `obj_xxx`-style and bare hex; CQ-010 test
    case in `normalization.test.ts`.
  - CQ-011 — `promotionReceiptV2Schema.superRefine` enforces
    `payload.receiptId === deriveReceiptId(payload)`; `GetReceiptRequest`
    and `not_found` response use `receiptIdSchema`; new tests in
    `schemas.test.ts`.
  - CQ-012 — `transportHashSchema` exported; `transportHash` mandatory on
    `uploadSegmentRequestSchema` and `uploadObjectPackHeaderSchema`;
    `CANONICAL.md` rule 6 hash-kind table includes a `TransportHash` row;
    schema tests reject missing/malformed values.
  - CQ-013 — `CANONICAL.md` rule 11 calls out `content_hash` /
    `stored_hash` as tagged-hash form, matching the helper signatures and
    Zod schemas; the hash-kind table also pins `ManifestDigest` as
    tagged-hash form everywhere.
  - CQ-014 — `isValidCanonicalTimestamp` round-trips via `Date.UTC`;
    `canonicalTimestamp` rejects component bounds violations and
    impossible calendar dates (Feb 30); `normalization.test.ts` covers
    month 13/99, Feb 30, hour 24, minute 60, second 60.
  - CQ-015 — `gates.md`, `status.md`, and this evidence file rewritten
    from this iteration's actual final command outputs; historical
    failures kept only as dated notes.
- Codex will re-review after the CQ-010..CQ-015 closeout commit; new
  findings will surface as fresh `CQ-NNN` entries before Lane 1 begins.
- Codex final re-review after `b78b5ae`/`70b9df0` opened `CQ-016` through
  `CQ-019` for wire timestamp semantics, remaining spec contradictions,
  conformance fixture independence, and evidence/worktree consistency. Lane 0
  remains in correction while those are open.
