import { bigint, index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'
import { organization } from './auth.js'
import { syncBatch } from './sync.js'

export const remoteObject = pgTable(
  'remote_object',
  {
    objectId: text('object_id').primaryKey(),
    hash: text('hash').notNull(),
    hashAlgorithm: text('hash_algorithm').notNull().default('blake3'),
    compression: text('compression').notNull().default('zstd'),
    uncompressedSize: bigint('uncompressed_size', { mode: 'bigint' }).notNull(),
    compressedSize: bigint('compressed_size', { mode: 'bigint' }).notNull(),
    storageKey: text('storage_key').notNull().unique(),
    contentType: text('content_type'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    hashIdx: index('remote_object_hash_idx').on(table.hash),
  }),
)

export const tenantObject = pgTable(
  'tenant_object',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    objectId: text('object_id')
      .notNull()
      .references(() => remoteObject.objectId, { onDelete: 'restrict' }),
    firstBatchId: text('first_batch_id').references(() => syncBatch.id, { onDelete: 'set null' }),
    refCount: integer('ref_count').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.objectId] }),
  }),
)
