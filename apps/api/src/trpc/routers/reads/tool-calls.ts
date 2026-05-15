import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { router, tenantProcedure } from '../../init.js'
import { cursorPageInput, sourceFilter, timeRangeFilter } from './shared.js'

const toolCallsListInput = cursorPageInput
  .merge(timeRangeFilter)
  .merge(sourceFilter)
  .extend({
    sessionId: z.string().optional(),
    toolNames: z.array(z.string()).optional(),
    canonicalToolTypes: z.array(z.string()).optional(),
    statuses: z.array(z.string()).optional(),
    errorsOnly: z.boolean().optional(),
    pathSubstring: z.string().optional(),
  })

export const toolCallsRouter = router({
  /**
   * CQ-004: `projection_tool_call` rows are auxiliary projection rows that
   * have no row-level verified provenance in v0. The promotion manifest
   * (`sync_batch_projection_manifest`) only carries `session` and
   * `search_doc` entity types, so directly-inserted or pre-promotion rows
   * cannot be told apart from verified ones. Until the manifest grows
   * `tool_call` (and related auxiliary types), this surface fails closed
   * with an empty page and a `verifiedAuxiliaryAvailable: false` flag.
   *
   * CQ-005: the unsupported-filter checks remain so callers that pass
   * `canonicalToolTypes` or `pathSubstring` still get an explicit refusal
   * rather than a silently-ignored filter.
   */
  list: tenantProcedure.input(toolCallsListInput.default({})).query(async ({ input }) => {
    if (input.canonicalToolTypes && input.canonicalToolTypes.length > 0) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'canonicalToolTypes filter is not supported by the remote projection v0.',
      })
    }
    if (input.pathSubstring) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'pathSubstring filter is not supported by the remote projection v0.',
      })
    }
    return {
      rows: [],
      nextCursor: null as string | null,
      verifiedAuxiliaryAvailable: false as const,
    }
  }),
})
