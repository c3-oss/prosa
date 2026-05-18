# Canonical encoding rules — prosa v2

These rules are the authority for every Merkle leaf and signed-receipt byte
computed across the prosa v2 system. They are mirrored in `src/canonical.ts`
and pinned by the conformance test at `test/conformance/leaves.test.ts` in the
workspace root. **Any change to a rule here requires regenerating the
conformance fixture (CQ-008), writing a Lane 0 ADR, and re-verifying every
downstream lane that already depends on the prior leaves.**

See `docs/rearch/17-review-of-proposal-3.md` L15 for the load-bearing pin
this file enforces, and the open Lane 0 corrections in
`docs/roadmap/rearch-2/correction-queue.md` (CQ-001…CQ-008) for the
rationale behind each rule.

## 1. Field order

Fields appear in *schema order*, not object/map iteration order. Schema order
is the order declared in `packages/prosa-types-v2/src/entities/<name>.ts` (the
`*_FIELDS` tuple) and surfaced as `ENTITY_SCHEMA_ORDER[entityType]`.

For receipt payloads, the same rule applies via `RECEIPT_PAYLOAD_FIELDS` and
`MATERIALIZATION_FIELDS` / `VERIFICATION_FIELDS` / `BUNDLE_COUNTS_FIELDS`
(CQ-005).

## 2. Null

Encoded as canonical CBOR null (`0xf6`). Omitted optional fields encode as
null — `canonicalCbor(row, fields)` substitutes null for any undefined
property.

## 3. Integers

Canonical CBOR integers in the smallest representation (RFC 8949 §4.2.1).
Negative integers use major type 1 with argument `-1 - n`. Values exceeding
`Number.MAX_SAFE_INTEGER` must be passed as `bigint`; passing them as
`number` throws.

## 4. Strings

UTF-8 with NFC normalization applied before encoding. The encoder normalizes
inputs so producers cannot drift; producers should still NFC-normalize at
ingest to avoid downstream surprises.

## 5. Timestamps (CQ-002, CQ-014, CQ-022)

UTC RFC3339 with millisecond precision. Canonical form:
`YYYY-MM-DDTHH:MM:SS.sssZ` with **exactly three** fractional digits.
Sub-millisecond precision is **truncated** (not rounded) toward the epoch.
No fractional part = `.000Z`.

Semantic UTC validity is required: the regex shape alone is not
sufficient. A canonical timestamp must round-trip through `Date.UTC`
(or an equivalent calendar-component check) — month 1–12, day 1–31,
hour ≤ 23, minute ≤ 59, second ≤ 59, AND the component tuple must form
a real UTC instant (so Feb 30, hour 24, etc. are rejected).
Implementations expose this via `isValidCanonicalTimestamp(input)` in
`canonical.ts`.

`merkleLeaf` validates every timestamp-typed field (per the entity's
`FIELD_KIND` metadata) using the semantic check above. Non-canonical
timestamps are **rejected**, not silently normalized — silent
normalization would let two producers compute different leaves from the
same logical input. Producers must canonicalize via
`canonicalTimestamp(input)` at ingest.

## 6. Identifiers and hashes (CQ-002, CQ-004)

`merkleLeaf` rejects non-canonical identifier and hash inputs:

- **Object IDs, entity IDs**: lowercase, no whitespace, must match
  the exact implementation regex `^[a-z0-9][a-z0-9_:-]*$` — IDs start
  with a lowercase letter or digit, and the rest may add `_`, `:`, or
  `-`. Uppercase, leading punctuation, and any other character are
  **rejected** (not normalized). CQ-022.
- **Tagged hashes** (e.g. `blake3:<hex>`, `pack_digest`, `object_id` when
  expressed as a tagged hash): match `^blake3:[0-9a-f]{64}$`. Uppercase hex
  and missing algorithm prefix are **rejected**.
- **Bare hex hashes** (`bundleRoot`, `rawSourceRoot`, `objectSetRoot`):
  match `^[0-9a-f]{64}$` (lowercase only). `manifestDigest` is **not**
  bare hex — it carries the tagged form `blake3:<hex>` everywhere
  (CQ-013 / CQ-017).

Hash-typed fields are distinguished by semantics, not by name:

| Concept | Definition | Carrier |
| --- | --- | --- |
| `ObjectId` | BLAKE3 over the **uncompressed original bytes** of a logical object. The canonical content identity. | `*.object_id`, raw pack entry `object_id`. Bare 64-char hex when stored alongside an algorithm field; tagged-hash form on the wire. |
| `UncompressedHash` | Synonym of `ObjectId`. Used inside raw-pack entries to make the identity explicit when compression also produces a separate digest. | `raw_source_pack_entry.uncompressed_hash`. |
| `StoredHash` | BLAKE3 over the bytes as **stored on disk / on the wire** (after any compression). Different from `ObjectId` when `compression != 'none'`. | `raw_source_pack_entry.stored_hash`. |
| `PackDigest` | BLAKE3 over the entire pack file's stored bytes. Used as the pack's content-address. | `PackRef.pack_digest`, `SegmentRef.digest`. Tagged-hash form. |
| `ObjectSetRoot` | BLAKE3 Merkle root over the sorted set of `ObjectId`s inside a pack. Cross-implementation verifiable. | `PackRef.object_set_root`. Bare 64-char hex. |
| `BundleRoot` | The cross-entity canonical projection Merkle root (rule 9 + rule 10). | `BundleHeadV2.bundleRoot`, `PromotionReceiptV2.bundleRoot`. Bare 64-char hex. |
| `RawSourceRoot` | Merkle root over preserved source-file bytes (rule 11). | `BundleHeadV2.rawSourceRoot`, `PromotionReceiptV2.rawSourceRoot`. Bare 64-char hex. |
| `ManifestDigest` | BLAKE3 over the manifest's serialized bytes. Distinct from `BundleRoot`; used as the local manifest's content address only. Tagged-hash form `blake3:<hex>` everywhere (CQ-013). | `BundleHeadV2.manifestDigest`. |
| `TransportHash` | BLAKE3 over the bytes observed on the upload transport (chunked or not). Distinct from `PackDigest`: a retried/recompressed upload may keep the same `PackDigest` but produce a different `TransportHash`. Tagged-hash form. | Wire envelope only — not stored in the bundle (CQ-012). |

Zod schemas in `prosa-wire-v2` use the matching tagged-hash or bare-hex
regex per concept. Any wire payload that conflates these is rejected.

## 7. Sort order for Merkle trees

- *Within an entity type*: leaves are sorted by primary_key ASCENDING
  bytewise (UTF-8). The primary key field is given by
  `ENTITY_PRIMARY_KEY[entityType]`.
- *Across entity types* (rule 10): the order in `CANONICAL_ENTITY_TYPES` —
  alphabetical: `artifact, content_block, edge, event, message, project,
  raw_record, search_doc, session, source_file, tool_call, tool_result,
  turn`.
- *Raw-source leaves* (rule 11): sorted by `source_file_id` ASCENDING
  bytewise.

## 8. Projection leaf computation

```text
leaf = blake3(
  'prosa.projection.leaf.v2'  // ASCII, 24 bytes, no NUL terminator
  || entity_type              // ASCII, e.g. 'session'
  || primary_key              // UTF-8, the row's primary key string
  || canonical_cbor(row_tuple)
)
```

`entity_type` and `primary_key` are concatenated with no length prefix or
separator — the structure is locked by rules 1 and 7. `canonical_cbor`
produces a fixed-length CBOR array of the row's fields in schema order,
**after** rule 5 and rule 6 validation.

## 9. Tree construction

- Binary Merkle tree.
- Inner nodes hashed with BLAKE3 over the 64-byte `left||right` concatenation.
- Odd leaves at any level: the lone leaf is hashed against itself
  (`left = right`).
- An empty entity type contributes 32 zero bytes as its subroot.

## 10. `bundleRoot` (CQ-001)

`bundleRoot` is **the cross-entity canonical projection Merkle root**:

```text
bundleRoot = merkleRoot([
  subroot('artifact'),
  subroot('content_block'),
  …
  subroot('turn'),
])
```

Properties (all enforced by tests):

- Row insertion order within an entity does **not** change `bundleRoot`.
- Changing or reordering segments / pack manifests does **not** change
  `bundleRoot`. Manifest byte content is hashed separately into
  `BundleHeadV2.manifestDigest`.
- Adding, removing, or modifying any canonical projection row changes
  `bundleRoot`.

`bundleRoot` is the remote-authority key (Lane 5 `BeginPromotion` no-op
fast-path). `manifestDigest` is informational/local.

## 11. `rawSourceRoot` (CQ-003)

`rawSourceRoot` is the Merkle root over preserved source-file bytes,
independent of the canonical projection. Construction:

```text
raw_source_leaf = blake3(
  'prosa.rawsource.leaf.v2'   // ASCII, 23 bytes, no NUL terminator
  || source_file_id           // UTF-8
  || canonical_cbor([
       content_hash,           // ObjectId (BLAKE3 of uncompressed bytes), tagged form 'blake3:<hex>'
       uncompressed_size,      // integer
       compression,            // 'zstd' | 'none'
       stored_hash,            // StoredHash, tagged-hash form 'blake3:<hex>'
     ])
)

rawSourceRoot = merkleRoot(
  raw_source_leaf(entry)
    for entry in entries sorted by source_file_id ASC
)
```

- An empty set contributes 32 zero bytes (rule 9).
- Modifying any of (`content_hash`, `uncompressed_size`, `compression`,
  `stored_hash`) for any source file changes `rawSourceRoot`.
- The server recomputes `rawSourceRoot` from validated raw-source pack
  entries **before** issuing a receipt; mismatched roots fail closed
  (Lane 4 / Lane 5).
- The exact byte layout of raw-source packs is Lane 1's contract; this
  rule is just the receipt-side anchor.

## 12. Receipt payload bytes (CQ-005)

`receiptPayloadBytes(payload)` produces the deterministic byte string the
server hashes into `receiptId` and signs into `signature.sig`. It encodes
`PromotionReceiptV2Payload` as a canonical CBOR array using the field order
declared by `RECEIPT_PAYLOAD_FIELDS`. Nested objects (counts,
materialization, verification) are encoded as fixed-order arrays using
their own `*_FIELDS` tuples. `rowCountsByEntity` is encoded as the
`CANONICAL_ENTITY_TYPES`-ordered array of integers (no map encoding).

**Receipt-id zeroing rule (normative, CQ-017).** When deriving the
canonical `receiptId` from a payload, the `receiptId` field on the
payload MUST be encoded as the empty string `""` before
`receiptPayloadBytes(payload)` is computed. Otherwise the hash would
include whatever placeholder value the producer wrote, and two
implementations could not agree on the canonical id. The implementation
in `deriveReceiptId(payload)` enforces this by cloning the payload with
`receiptId = ''` before encoding.

```text
seed     = { ...payload, receiptId: '' }
receiptId = 'rcpt_' + base32_lower(
  blake3(receiptPayloadBytes(seed))
)
```

Any field change anywhere in the payload — bundle root, raw-source root,
counts, materialization commit, verification status — flips `receiptId`.
Tests pin all four arms.

## 13. Idempotency keys (CQ-006)

`source_file_id` and `raw_record_id` must be deterministic functions of the
ingest inputs so retries never duplicate or collapse rows. The pinned
derivations are:

```text
source_file_id = 'src_' + base32_lower(blake3(
  source_tool || 0x00 || path_nfc || 0x00 || content_hash
))

raw_record_id = 'raw_' + base32_lower(blake3(
  source_tool || 0x00 || source_file_id || 0x00 ||
  big_endian_u64(ordinal) || 0x00 || record_kind
))
```

- `path_nfc` is the NFC-normalized absolute path string.
- `content_hash` is the source file's `ObjectId` (BLAKE3 over uncompressed
  bytes).
- `ordinal` is the 0-based position of the record within the source file.
- `record_kind` is the canonical kind label
  (`'session_jsonl_line'`, `'session_sqlite_row'`, `'artifact_blob'`,
  `'project_meta'`, etc.).

`RawRecordV2` carries enough locator fields to reconstruct any preserved
record byte-for-byte from the raw-source pack: `ordinal`, `record_kind`,
`logical_offset`, `logical_length`, `parser_status`, `confidence`, plus
both the raw bytes' `object_id` and (when applicable) a decoded JSON
representation's `decoded_object_id`.

## Conformance fixture (CQ-008)

The committed `test/fixtures/canonical-leaves/expected-leaves.json` is the
**load-bearing artifact**. The test at `test/conformance/leaves.test.ts`
recomputes each leaf and asserts byte-for-byte equality against the
committed values. Any encoder change — intentional or accidental — flips
those leaves and fails the test.

The script `test/conformance/generate-expected.ts` is a **non-authoritative
helper**, useful only after a deliberate canonical-rule change has been
approved through a Lane 0 ADR. Regenerating without verification (e.g.
against an independent Rust or Go implementation, or hand-traced bytes
for a single representative row) silently launders drift into the fixture
and defeats the test's purpose. CI must never auto-update this fixture.

The fixture exists so that a future second implementation of these rules
(Rust, Go, or anything else) can verify byte-for-byte equality against the
same input rows. Every entity type has one row.
