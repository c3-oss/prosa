export interface ClampLimitOptions {
  min?: number
  max: number
  fallback: number
}

export function clampLimit(value: number | undefined, opts: ClampLimitOptions): number {
  return Math.max(opts.min ?? 1, Math.min(opts.max, value ?? opts.fallback))
}
