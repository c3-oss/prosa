export const getErrorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
