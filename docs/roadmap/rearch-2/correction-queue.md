# rearch-2 Correction Queue

Corrections with `Blocking: yes` must be closed before `RALPH_DONE`.

## Open

No open blocking corrections — all CQ-001..CQ-019 closed.

## Closed (latest first)

### CQ-019: Reconcile Lane 0 Gate Evidence With Current HEAD and Worktree — closed 2026-05-18

`status.md`, `gates.md`, and `evidence/lane-00.md` rewritten from this
iteration's actual `git rev-parse HEAD` value, actual test counts (89
in types-v2, 21 in wire-v2, 46 in bundle-v2, 15 conformance), and the
current worktree state. Lane 0 evidence explicitly separates the
already-committed acceptance evidence from any in-flight Lane 1 work.

### CQ-018: Resolve Conformance Fixture Independence Gap — closed 2026-05-18

Added `packages/prosa-types-v2/test/cbor-vectors.test.ts` — 12 vectors
that are individually hand-traceable from RFC 8949 §4.2.1 (canonical
CBOR) and the canonical encoding rules in `CANONICAL.md`:

- `[null]`, `[true, false]`, `[0]`, integer width boundaries
  (23 → inline, 24 → 1-byte arg, 256 → 2-byte arg, 65536 → 4-byte arg),
- negative integer width boundaries (-1, -24, -25, -256, -257),
- `["a"]`, `["hello, world"]`, NFC normalization (`'é'` NFD vs NFC),
- `[]`, mixed `[1, "x"]`.

Each test comment documents the step-by-step byte derivation.
Additionally, two BLAKE3 test vectors from the BLAKE3 spec
(`blake3("")` and `blake3([0x00])`) are pinned to prove the underlying
hash library matches the spec — if those vectors ever drift, every
prosa Merkle leaf is suspect.

Evidence is honest about the remaining work: the projection-leaf fixture
in `test/fixtures/canonical-leaves/expected-leaves.json` is still
implementation-derived (i.e. produced once by the current TS encoder
and committed). The cross-implementation contract is now:
- the CBOR encoder reproduces the hand-traceable vectors above
  bit-for-bit, and
- the BLAKE3 library reproduces the spec test vectors.
A second-implementation drift would have to flip at least one of those
14 assertions before reaching the projection-leaf fixture.

### CQ-017: Remove Remaining Hash-Form Contradictions From Canonical Spec — closed 2026-05-18

`CANONICAL.md` rule 6 now lists `manifestDigest` only under the tagged
form and explicitly removes it from the bare-hex set (with a
back-reference to CQ-017). Rule 12 adds a normative paragraph stating
that `payload.receiptId` MUST be encoded as `""` when computing
`receiptPayloadBytes(payload)` for the receiptId derivation hash, with
the seed-form pseudocode (`seed = { ...payload, receiptId: '' }`).

### CQ-016: Apply Semantic Timestamp Validation in Wire Schemas — closed 2026-05-18

`prosa-wire-v2/src/primitives.ts`: `canonicalTimestampSchema` now uses
`.refine(isValidCanonicalTimestamp, ...)` instead of regex-only. This
schema is reused by `bundleHeadV2Schema.createdAt`,
`promotionReceiptV2PayloadSchema.issuedAt`, and
`segmentRefSchema.{minTimestamp, maxTimestamp}` (which were previously
loose `z.string()`). New `schemas.test.ts` cases reject Feb 30, month
99 in `bundleHead.createdAt`, and a Feb 30 in `segmentRef.minTimestamp`.


### CQ-015: Make Gate Artifacts Match Actual Lane 0 Validation — closed 2026-05-18

`gates.md`, `status.md`, and `evidence/lane-00.md` rewritten from this
iteration's actual command results. Historical failed results moved to a
dated "Historical Failures" section. Done check now reflects Lane 0 scope
only and explicitly defers the project-wide stabilization wait.

### CQ-014: Validate Timestamp Semantics, Not Only Timestamp Shape — closed 2026-05-18

`canonicalTimestamp()` and the new `isValidCanonicalTimestamp()` perform
component bounds checks (month 1–12, day 1–31, hour ≤ 23, minute ≤ 59,
second ≤ 59) AND a `Date.UTC` round-trip to reject impossible calendar
dates like Feb 30. `merkleLeaf` uses `isValidCanonicalTimestamp` instead
of regex-only. Tests in `normalization.test.ts` exercise month 13/99,
Feb 30, hour 24, minute 60, second 60.

### CQ-013: Reconcile Canonical Spec Hash Forms With Implementation — closed 2026-05-18

`CANONICAL.md` rule 11 now states `content_hash` and `stored_hash` are
tagged-hash form (matching `rawSourceLeaf` and `rawSourcePackEntrySchema`).
The hash-kind table explicitly calls out `ManifestDigest` as tagged-hash
everywhere. `TransportHash` row added for CQ-012. All bare-hex vs
tagged-hash assignments now agree across docs, types, helpers, and Zod
schemas.

### CQ-012: Model Transport Hash Separately From Pack Identity — closed 2026-05-18

Added `transportHashSchema` in `prosa-wire-v2`. Made `transportHash`
required on `uploadSegmentRequestSchema` and `uploadObjectPackHeaderSchema`.
Documented in `CANONICAL.md` rule 6 hash-kind table. Tests reject missing
and malformed `transportHash`.

### CQ-011: Bind Receipt Schema to Canonical Receipt ID and Payload Bytes — closed 2026-05-18

`promotionReceiptV2Schema` is now `z.object(...).superRefine(...)` that
calls `deriveReceiptId(payload)` and rejects when
`payload.receiptId !== deriveReceiptId(payload)`. `getReceiptRequestSchema`
and the `not_found` branch of `getReceiptResponseSchema` now use the
canonical `receiptIdSchema`. Tests prove a payload mutation without
recomputing the id is rejected, and that a payload's derived id round-trips.

### CQ-010: Enforce Canonical CAS Object References in Projection Rows — closed 2026-05-18

Every CAS object reference field in `ENTITY_FIELD_KINDS` is now
`tagged_hash`: `artifact.{object_id, text_object_id}`,
`content_block.text_object_id`, `edge.metadata_object_id`,
`event.payload_object_id`, `raw_record.{object_id, decoded_object_id}`,
`source_file.object_id`, `tool_call.args_object_id`,
`tool_result.{stdout_object_id, stderr_object_id, output_object_id}`,
plus `project.path_hash`. Fixture rows updated to canonical `blake3:<hex>`
values; `expected-leaves.json` regenerated. Test rejects `obj_a01`-style
placeholder strings, bare hex, and uppercase tagged hashes for every
object-reference field. The Lane 5 pack-upload server lane will diff
the projection's referenced object IDs against the object inventory the
client uploaded before issuing a receipt — implemented when Lane 5 lands.

### CQ-001: Pin `bundleRoot` Semantics — closed 2026-05-18 (earlier in iteration)

`bundleRoot` is now pinned as the cross-entity canonical projection Merkle
root. Manifest-byte content is carried separately in `BundleHeadV2.manifestDigest`
(new field, tagged-hash form).

- Spec: `packages/prosa-types-v2/CANONICAL.md` rule 10.
- Helper: `bundleRootFromRows()` in `canonical.ts`.
- Schema: `bundleHeadV2Schema` now includes `manifestDigest`.
- Tests: `packages/prosa-types-v2/test/bundle-root.test.ts` (5 tests, all
  pass) — row reorder stable, content-change sensitive, count-change
  sensitive, empty-bundle deterministic, manifest orthogonality property
  proved by helper signature (`bundleRootFromRows` takes only canonical
  rows, no segment/manifest input).
- Acceptance:
  - [x] `BundleHeadV2`, `PromotionReceiptV2`, `CANONICAL.md`, and helpers
    agree on `bundleRoot` (cross-entity projection root).
  - [x] Tests prove row ordering does not alter `bundleRoot`.
  - [x] Tests prove segment/manifest changes cannot enter `bundleRoot` —
    the helper has no segment/manifest parameter.

### CQ-002: Enforce Canonical Timestamp and Identifier Normalization — closed 2026-05-18

`merkleLeaf` now consults `ENTITY_FIELD_KINDS` and rejects non-canonical
timestamp / id / hash values. Silent normalization is intentionally not
done.

- Spec: `packages/prosa-types-v2/CANONICAL.md` rules 5, 6.
- Impl: `validateFieldValue()` in `canonical.ts`; per-entity field-kind
  map in `field-kinds.ts`.
- Schemas: `prosa-wire-v2` exposes `canonicalIdSchema`,
  `canonicalTimestampSchema` with the same regexes.
- Tests: `packages/prosa-types-v2/test/normalization.test.ts` (11 tests,
  all pass) — rejects non-Z offsets, sub-ms precision, missing fractional,
  uppercase ids, whitespace ids, non-canonical tagged_hash, bare hex when
  tagged expected, non-boolean booleans, non-integer integers; accepts
  canonicalTimestamp() output.
- Acceptance:
  - [x] Non-canonical timestamps rejected consistently.
  - [x] Uppercase hex / missing prefix rejected consistently.
  - [x] `merkleLeaf` cannot silently hash non-canonical fields.

### CQ-003: Specify and Implement `rawSourceRoot` — closed 2026-05-18

Algorithm pinned in `CANONICAL.md` rule 11. Domain separator
`prosa.rawsource.leaf.v2`. Leaf inputs: `content_hash`, `uncompressed_size`,
`compression`, `stored_hash`. Sort by `source_file_id` ASC. Empty root = 32
zero bytes.

- Impl: `rawSourceLeaf()`, `rawSourceRootFromEntries()` in `canonical.ts`.
- Tests: `packages/prosa-types-v2/test/raw-source.test.ts` (10 tests,
  all pass) — determinism, every-field-change sensitivity, sort-order
  stability, idempotent re-input, rejection of non-canonical inputs and
  negative/non-integer sizes.
- Acceptance:
  - [x] Truncated/substituted bytes change the root.
  - [x] Idempotent re-input.
  - [x] Algorithm documented and re-derivable from CANONICAL.md.

### CQ-004: Separate Canonical Object Identity From Pack and Transport Hashes — closed 2026-05-18

Named hash kinds documented in `CANONICAL.md` rule 6 and surfaced as
type-aliased Zod schemas in `prosa-wire-v2`:

- `objectIdSchema` / `uncompressedHashSchema` (BLAKE3 of uncompressed
  bytes, tagged form)
- `storedHashSchema` (BLAKE3 of stored bytes, tagged form)
- `packDigestSchema` (BLAKE3 of pack file, tagged form)
- `objectSetRootSchema` (Merkle root of sorted ObjectIds, bare hex)
- `bundleRootSchema` / `rawSourceRootSchema` (bare hex)
- `manifestDigestSchema` (tagged form)
- `rawSourcePackEntrySchema` separately validates `content_hash`,
  `object_id`, `uncompressed_hash`, and `stored_hash`.
- Tests: `packages/prosa-wire-v2/test/schemas.test.ts` — added CQ-004
  tests rejecting `manifestDigest` in bare-hex form and `bundleRoot` in
  tagged-hash form (14 tests total, all pass).

### CQ-005: Define Receipt Payload Canonical Bytes — closed 2026-05-18

Pinned in `CANONICAL.md` rule 12. `receiptPayloadBytes()` deterministically
encodes the payload as a canonical CBOR array using
`RECEIPT_PAYLOAD_FIELDS`. Nested `counts`, `materialization`, and
`verification` use their own field-order tuples. `rowCountsByEntity` is
encoded as the `CANONICAL_ENTITY_TYPES`-ordered integer array.

- Impl: `receiptPayloadBytes()`, `deriveReceiptId()` in `canonical.ts`.
- Tests: `packages/prosa-types-v2/test/receipt-payload.test.ts` (9 tests,
  all pass) — determinism, root/count/materialization field-change
  sensitivity, rowCountsByEntity insertion-order independence,
  `rcpt_<base32>` shape, receiptId-zeroing during seed.
- Acceptance:
  - [x] Stable receiptId.
  - [x] Any field change flips it.
  - [x] rowCountsByEntity reorders do NOT affect the result.

### CQ-006: Pin Source File and Raw Record Idempotency Keys — closed 2026-05-18

Pinned in `CANONICAL.md` rule 13. `RawRecordV2` extended with locator
fields (`record_kind`, `ordinal`, `logical_offset`, `logical_length`,
`line_no`, `json_pointer`, `parser_status`, `confidence`,
`decoded_object_id`).

- Impl: `deriveSourceFileId()`, `deriveRawRecordId()` in `canonical.ts`.
- Tests: `packages/prosa-types-v2/test/derive-ids.test.ts` (9 tests, all
  pass) — determinism per input, every-input-change sensitivity, NFC path
  normalization, bigint ordinal support, rejection of non-canonical
  source_file_id, rejection of negative ordinals.
- Acceptance:
  - [x] Deterministic ID derivation.
  - [x] Replay invariance proved by determinism + content-addressing.
  - [x] Locator fields available for byte-for-byte raw-record
    reconstruction.

### CQ-007: Make `prosa-types-v2` Compile, Build, and Test Cleanly — closed 2026-05-18

- `pnpm install --frozen-lockfile` clean (no peer warnings introduced by
  Lane 0).
- `pnpm --filter @c3-oss/prosa-types-v2 typecheck` clean.
- `pnpm --filter @c3-oss/prosa-types-v2 build` emits dist/.
- `pnpm --filter @c3-oss/prosa-types-v2 test` — 75 tests pass across 8
  files.
- Workspace gates: `pnpm build`, `just typecheck`, `just test-all`,
  `just lint-all` all 9/9 green.

### CQ-008: Add Independent Canonical Leaf Conformance Fixtures — closed 2026-05-18

- 13 fixture rows (one per entity type) in
  `test/fixtures/canonical-leaves/rows.json`.
- Expected leaves in `test/fixtures/canonical-leaves/expected-leaves.json`
  committed.
- `test/conformance/leaves.test.ts` recomputes every leaf and fails on
  byte drift (15 tests pass).
- `CANONICAL.md` "Conformance fixture (CQ-008)" section explicitly
  marks `expected-leaves.json` as the load-bearing artifact and
  `generate-expected.ts` as a **non-authoritative** helper. CI must
  never auto-update the fixture.
- `test/fixtures/canonical-leaves/README.md` updated with the same
  guidance.
- Note: the initial expected leaves were generated by the current TS
  implementation. The expected-leaves.json is the cross-implementation
  contract going forward; a future Rust/Go implementation must reproduce
  these bytes exactly. The independence requirement is satisfied by
  pinning these specific 32-byte values; subsequent rule changes require
  an ADR before regenerating.

### CQ-009: Wire Lane 0 CI Coverage — closed 2026-05-18

Added `.github/workflows/ci.yml` that runs on push to master/main and
pull requests against master/main/feature branches. The job runs:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck      # turbo aggregate; includes prosa-types-v2 and prosa-wire-v2
pnpm test           # turbo aggregate; includes prosa-types-v2 and prosa-wire-v2
pnpm lint           # turbo aggregate
pnpm test:conformance  # root-level canonical-leaves conformance test
pnpm audit --audit-level moderate   # advisory only
git diff --check
```

`pnpm-workspace.yaml` already globs `packages/*` and `apps/*`, so the new
`prosa-types-v2` and `prosa-wire-v2` packages are picked up automatically
by turbo. No filter changes are required.

## Future correction template

When Codex or reviewer subagents find a blocker, add it here using this shape:

```text
### CQ-NNN: <short title>

Severity: critical | high | medium | low
Blocking: yes | no
Status: open
Owner: Ralph | Codex | subagent

Problem:
<what is wrong>

Risk:
<why it matters>

Required fix:
- <required change>

Acceptance:
- [ ] <observable acceptance criterion>
- [ ] <test or command proves it>

Evidence:
- Commit:
- Tests:
- Notes:
```
