import { z } from 'zod'
import { router, tenantProcedure } from '../init.js'

const prefKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._-]+$/, 'pref key may only contain alphanumerics, dot, underscore, hyphen')

/**
 * Per-user, per-tenant preference bag. The shape of `value` is opaque to the
 * server — clients pick a stable namespace (e.g. `dashboard.layout.v1`) and
 * are responsible for validating the payload they read back.
 */
export const userPrefsRouter = router({
  get: tenantProcedure.input(z.object({ key: prefKeySchema })).query(async ({ ctx, input }) => {
    const rows = await ctx.rawExec<{ value: unknown }>(
      `SELECT value FROM "user_pref"
        WHERE user_id = $1 AND tenant_id = $2 AND key = $3
        LIMIT 1`,
      [ctx.user.id, ctx.tenantId, input.key],
    )
    return { value: rows[0]?.value ?? null }
  }),

  set: tenantProcedure.input(z.object({ key: prefKeySchema, value: z.unknown() })).mutation(async ({ ctx, input }) => {
    await ctx.rawExec(
      `INSERT INTO "user_pref"(user_id, tenant_id, key, value, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, now())
         ON CONFLICT (user_id, tenant_id, key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [ctx.user.id, ctx.tenantId, input.key, JSON.stringify(input.value ?? null)],
    )
    return { ok: true as const }
  }),
})
