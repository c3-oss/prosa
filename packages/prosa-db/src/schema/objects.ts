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
    storageKey: text('storage_key').unique(),
    contentType: text('content_type'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    hashIdx: index('remote_object_hash_idx').on(table.hash),
  }),
)

export const remoteBlob = pgTable(
  'remote_blob',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    batchId: text('batch_id').references(() => syncBatch.id, { onDelete: 'set null' }),
    storageKey: text('storage_key').notNull().unique(),
    hash: text('hash').notNull(),
    hashAlgorithm: text('hash_algorithm').notNull().default('blake3'),
    byteSize: bigint('byte_size', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantBatchIdx: index('remote_blob_tenant_batch_idx').on(table.tenantId, table.batchId),
  }),
)

export const remoteObjectLocation = pgTable(
  'remote_object_location',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    objectId: text('object_id')
      .notNull()
      .references(() => remoteObject.objectId, { onDelete: 'cascade' }),
    batchId: text('batch_id').references(() => syncBatch.id, { onDelete: 'set null' }),
    locationType: text('location_type').notNull(),
    blobId: text('blob_id').references(() => remoteBlob.id, { onDelete: 'restrict' }),
    storageKey: text('storage_key'),
    byteOffset: bigint('byte_offset', { mode: 'bigint' }).notNull().default(0n),
    byteLength: bigint('byte_length', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.objectId] }),
    blobRangeIdx: index('remote_object_location_blob_range_idx').on(table.blobId, table.byteOffset),
    storageKeyIdx: index('remote_object_location_storage_key_idx').on(table.storageKey),
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
