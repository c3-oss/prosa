// Lane 6 — opaque cursor encoding.
//
// Pagination cursors are base64url-encoded JSON over the full stable
// sort tuple, never offsets. Decoding a tampered cursor returns null
// so the read falls back to the first page instead of throwing — this
// matches the v1 trpc reads contract and keeps client-visible errors
// constrained.

export type CursorPayload = Record<string, string | number | null>

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeCursor<T extends CursorPayload = CursorPayload>(cursor: string | undefined | null): T | null {
  if (!cursor) return null
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T
    return null
  } catch {
    return null
  }
}

export type CursorPage<T> = {
  rows: T[]
  nextCursor: string | null
}
