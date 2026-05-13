/**
 * Compute a window of visible items centered on `selectedIndex` so the
 * selection stays in view as the user scrolls. Mirrors the helper from
 * `mzi-tfplan-explorer/components/visible-window.ts`.
 */
export function visibleWindow(args: {
  total: number
  selectedIndex: number
  height: number
}): { startIndex: number; endIndex: number } {
  const { total, selectedIndex, height } = args
  if (total === 0 || height <= 0) return { startIndex: 0, endIndex: 0 }
  const safeHeight = Math.min(height, total)
  let startIndex = Math.max(0, selectedIndex - Math.floor(safeHeight / 2))
  if (startIndex + safeHeight > total) startIndex = total - safeHeight
  if (startIndex < 0) startIndex = 0
  const endIndex = Math.min(total, startIndex + safeHeight)
  return { startIndex, endIndex }
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}
