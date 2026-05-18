import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
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

describe('canonical leaves conformance fixture', () => {
  const rows = JSON.parse(readFileSync(rowsPath, 'utf8')) as Record<CanonicalEntityType, Record<string, unknown>>

  it('has a row for every CanonicalEntityType', () => {
    for (const t of CANONICAL_ENTITY_TYPES) {
      expect(rows[t], `missing row for ${t}`).toBeDefined()
    }
  })

  it('expected-leaves.json exists (run generate-expected.ts if missing)', () => {
    expect(
      existsSync(expectedPath),
      `missing ${expectedPath}; run \`pnpm --filter @c3-oss/prosa-types-v2 exec tsx ../../test/conformance/generate-expected.ts\``,
    ).toBe(true)
  })

  const expected = existsSync(expectedPath)
    ? (JSON.parse(readFileSync(expectedPath, 'utf8')) as Record<string, string>)
    : {}

  for (const entityType of CANONICAL_ENTITY_TYPES) {
    it(`reproduces the expected leaf for ${entityType}`, () => {
      const row = rows[entityType]
      const leaf = toHex(merkleLeaf(entityType, row as Record<string, never>))
      expect(expected[entityType], `no expected leaf for ${entityType}`).toBeDefined()
      expect(leaf).toBe(expected[entityType])
    })
  }
})
