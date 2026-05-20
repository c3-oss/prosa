// Lane 6 — shared verified-projection gate.
//
// Every projection / search read in the v2 read API JOINs against
// `remote_authority_v2` so a row is only visible when its
// `(tenant_id, store_id, receipt_id)` triple matches the tenant's
// *current* authority for that store. Rows belonging to a superseded
// receipt — or to a tenant the caller does not control — must not
// surface. This module is the single source of truth for that gate;
// individual read handlers compose its SQL fragment instead of
// re-deriving the JOIN locally.

/**
 * Build a SQL fragment that gates a projection read on a current
 * `remote_authority_v2` row for the projection's `(tenant_id,
 * store_id, receipt_id)` triple.
 *
 * The fragment uses the supplied parameter placeholder for the
 * tenant id so the caller controls $-positional binding. The
 * projection table must expose `store_id` and `receipt_id` columns;
 * Lane 6 added them to every projection table in
 * `packages/prosa-db-v2/src/schema/projection.ts`.
 *
 * Example:
 *   const sql = `SELECT * FROM projection_session s
 *                 WHERE ${verifiedProjectionWhere('s', '$1')}`
 */
export function verifiedProjectionWhere(alias: string, tenantParam = '$1'): string {
  return `${alias}.tenant_id = ${tenantParam}
    AND EXISTS (
      SELECT 1
        FROM remote_authority_v2 a
       WHERE a.tenant_id = ${alias}.tenant_id
         AND a.store_id = ${alias}.store_id
         AND a.current_receipt_id = ${alias}.receipt_id
    )`
}

/**
 * Variant for `search_doc`, which uses the same `(tenant_id, store_id,
 * receipt_id)` gate as the projection tables.
 */
export const verifiedSearchWhere = verifiedProjectionWhere

/**
 * Tables that the verified-projection gate must cover. Used by the
 * lint test to catch a new read path that reads from one of these
 * tables without composing the gate fragment.
 */
export const VERIFIED_PROJECTION_TABLES: readonly string[] = [
  'projection_session',
  'projection_message',
  'projection_tool_call',
  'projection_tool_result',
  'projection_event',
  'projection_content_block',
  'projection_artifact',
  'search_doc',
]
