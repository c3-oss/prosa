import { describe, expect, it } from 'vitest'
import { type ColumnSet, maxWidthsForColumns, resolveColumns, tailColumnsFor } from '../../src/cli/columns.js'

type Col = 'a' | 'b' | 'c'

const SET: ColumnSet<Col> = {
  default: ['a', 'b'],
  all: ['a', 'b', 'c'],
  maxWidths: { a: 10, c: 30 },
  tail: new Set<Col>(['c']),
}

describe('resolveColumns', () => {
  it('returns the default set when nothing is requested', () => {
    expect(resolveColumns(SET, undefined)).toEqual(['a', 'b'])
  })

  it('returns the default set when the literal `default` is requested', () => {
    expect(resolveColumns(SET, 'default')).toEqual(['a', 'b'])
  })

  it('returns the full set when `all` is requested', () => {
    expect(resolveColumns(SET, 'all')).toEqual(['a', 'b', 'c'])
  })

  it('returns the explicit subset when a CSV list is requested', () => {
    expect(resolveColumns(SET, 'b,c')).toEqual(['b', 'c'])
  })

  it('ignores empty entries and surrounding whitespace in the CSV', () => {
    expect(resolveColumns(SET, ' a , , c ')).toEqual(['a', 'c'])
  })

  it('falls back to the default set when the CSV resolves to nothing', () => {
    expect(resolveColumns(SET, ' , ')).toEqual(['a', 'b'])
  })

  it('throws on an unknown column with a helpful message', () => {
    expect(() => resolveColumns(SET, 'a,nope')).toThrow(/unknown column: nope/)
  })
})

describe('maxWidthsForColumns', () => {
  it('returns only the caps for columns being rendered', () => {
    const widths = maxWidthsForColumns(SET, ['a', 'b'])
    expect(widths).toEqual({ a: 10 })
  })

  it('returns undefined when no rendered column has a cap', () => {
    expect(maxWidthsForColumns(SET, ['b'])).toBeUndefined()
  })

  it('returns undefined when the column set declares no caps', () => {
    const bare: ColumnSet<Col> = { default: ['a'], all: ['a'] }
    expect(maxWidthsForColumns(bare, ['a'])).toBeUndefined()
  })
})

describe('tailColumnsFor', () => {
  it('returns only the tail columns being rendered', () => {
    expect(tailColumnsFor(SET, ['a', 'b', 'c'])).toEqual(new Set(['c']))
  })

  it('returns undefined when no rendered column is a tail column', () => {
    expect(tailColumnsFor(SET, ['a', 'b'])).toBeUndefined()
  })

  it('returns undefined when the column set declares no tail columns', () => {
    const bare: ColumnSet<Col> = { default: ['a'], all: ['a'] }
    expect(tailColumnsFor(bare, ['a'])).toBeUndefined()
  })
})
