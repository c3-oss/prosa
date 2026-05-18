// Regenerates test/fixtures/canonical-leaves/expected-leaves.json from
// test/fixtures/canonical-leaves/rows.json using the canonical encoding
// helpers in @c3-oss/prosa-types-v2.
//
// Run via:
//   pnpm --filter @c3-oss/prosa-types-v2 exec tsx ../../test/conformance/generate-expected.ts
//
// Do not regenerate casually — see CANONICAL.md and
// test/fixtures/canonical-leaves/README.md.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CANONICAL_ENTITY_TYPES,
  type CanonicalEntityType,
  merkleLeaf,
  toHex,
} from '../../packages/prosa-types-v2/src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = resolve(here, '..', 'fixtures', 'canonical-leaves')
const rowsPath = resolve(fixtureDir, 'rows.json')
const expectedPath = resolve(fixtureDir, 'expected-leaves.json')

const rows = JSON.parse(readFileSync(rowsPath, 'utf8')) as Record<CanonicalEntityType, Record<string, unknown>>

const expected: Record<string, string> = {}
for (const entityType of CANONICAL_ENTITY_TYPES) {
  const row = rows[entityType]
  if (!row) throw new Error(`missing row for ${entityType}`)
  expected[entityType] = toHex(merkleLeaf(entityType, row as Record<string, never>))
}

writeFileSync(expectedPath, `${JSON.stringify(expected, null, 2)}\n`, 'utf8')
console.log(`wrote ${expectedPath}`)
