# canonical-leaves conformance fixture

Each `*.json` file holds **one** projection-grain row per
`CanonicalEntityType`. The corresponding BLAKE3 leaf hex is recorded in
`expected-leaves.json`.

`test/conformance/leaves.test.ts` loads every row, recomputes the leaf with
`merkleLeaf(entityType, row)`, and asserts byte-for-byte equality against
`expected-leaves.json`.

This is the **implementer-drift catcher** for the canonical encoding rules in
`packages/prosa-types-v2/CANONICAL.md`. A divergent implementation (Rust, Go,
or a refactor of the TS encoder) must reproduce the same hex values.

## Updating the fixture

Updating any row or any of the canonical encoding rules requires:

1. Running `pnpm --filter @c3-oss/prosa-types-v2 exec tsx
   ../../test/conformance/generate-expected.ts` to regenerate
   `expected-leaves.json`.
2. Adding a Lane 0 ADR documenting the rule change and the new leaves.
3. Updating every downstream lane that already depends on the prior leaves.

Do **not** regenerate the fixture casually — drift is what this test is
designed to detect.
