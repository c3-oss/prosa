import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { router, tenantProcedure } from '../../init.js'
import { cursorPageInput, sourceFilter, timeRangeFilter } from './shared.js'

const searchInput = cursorPageInput
  .merge(timeRangeFilter)
  .merge(sourceFilter)
  .extend({
    q: z.string().min(1).max(500),
    sessionId: z.string().optional(),
    projectIds: z.array(z.string()).optional(),
    roles: z.array(z.string()).optional(),
    toolNames: z.array(z.string()).optional(),
    canonicalToolTypes: z.array(z.string()).optional(),
    fieldKinds: z.array(z.string()).optional(),
    errorsOnly: z.boolean().optional(),
    mode: z.enum(['plain', 'raw']).default('plain'),
  })

/**
 * CQ-005: the remote search projection (`search_doc`) only stores
 * `{ id, session_id, kind, body, indexed_at }` — no `tsvector`, no role,
 * tool, canonical-tool, or rank columns. The lane 04 contract claims
 * Postgres FTS with rank/snippet/field-kind mapping and a richer filter
 * set; until the projection grows those columns and the promotion
 * manifest can verify per-row provenance, remote `search.query` fails
 * closed instead of serving `ILIKE` rows under FTS semantics.
 *
 * Local Tantivy search remains available through the CLI.
 */
export const searchRouter = router({
  query: tenantProcedure.input(searchInput).query(async () => {
    throw new TRPCError({
      code: 'NOT_IMPLEMENTED',
      message:
        'Remote search v0 is unavailable. The promoted search_doc projection lacks the FTS, rank, role, tool, and field-kind columns required by the lane 04 contract. Use the CLI/local Tantivy engine until the projection schema is extended.',
    })
  }),
})
