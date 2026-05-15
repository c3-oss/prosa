import { describe, expect, it } from 'vitest'
import { clamp, visibleWindow } from '../../src/tui/use-visible-window.js'

describe('visibleWindow', () => {
  it('returns an empty window for empty or non-positive dimensions', () => {
    expect(visibleWindow({ total: 0, selectedIndex: 0, height: 10 })).toEqual({
      startIndex: 0,
      endIndex: 0,
    })
    expect(visibleWindow({ total: 5, selectedIndex: 2, height: 0 })).toEqual({
      startIndex: 0,
      endIndex: 0,
    })
  })

  it('keeps the selected row visible near the start, middle, and end', () => {
    expect(visibleWindow({ total: 20, selectedIndex: 0, height: 5 })).toEqual({
      startIndex: 0,
      endIndex: 5,
    })
    expect(visibleWindow({ total: 20, selectedIndex: 10, height: 5 })).toEqual({
      startIndex: 8,
      endIndex: 13,
    })
    expect(visibleWindow({ total: 20, selectedIndex: 19, height: 5 })).toEqual({
      startIndex: 15,
      endIndex: 20,
    })
  })

  it('caps the window height at the total row count', () => {
    expect(visibleWindow({ total: 3, selectedIndex: 2, height: 10 })).toEqual({
      startIndex: 0,
      endIndex: 3,
    })
  })
})

describe('clamp', () => {
  it('clamps values to inclusive bounds', () => {
    expect(clamp(-1, 0, 5)).toBe(0)
    expect(clamp(3, 0, 5)).toBe(3)
    expect(clamp(9, 0, 5)).toBe(5)
  })
})
