/**
 * Bounds and default for CLI/API limit values.
 */
export interface ClampLimitOptions {
  min?: number
  max: number
  fallback: number
}

/**
 * Clamp a possibly-missing numeric limit into an inclusive range.
 *
 * Undefined values resolve to `fallback`; omitted `min` defaults to 1 so
 * callers do not accidentally request empty or unbounded result sets.
 */
export function clampLimit(value: number | undefined, opts: ClampLimitOptions): number {
  return Math.max(opts.min ?? 1, Math.min(opts.max, value ?? opts.fallback))
}
