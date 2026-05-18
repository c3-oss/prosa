import { jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from './auth.js'
import { organization } from './auth.js'

/**
 * Per-user, per-tenant preferences stored as opaque JSON. Used today for the
 * console dashboard layout (`dashboard.layout.v1`); future surfaces can reuse
 * the same key/value bag without schema changes.
 */
export const userPref = pgTable(
  'user_pref',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.tenantId, table.key] }),
  }),
)
