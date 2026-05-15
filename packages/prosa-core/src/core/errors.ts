/**
 * Convert unknown caught values into a display/log-safe message string.
 */
export const getErrorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))
