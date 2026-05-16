import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { organization, user } from './auth.js'

export const device = pgTable(
  'device',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    platform: text('platform'),
    cliVersion: text('cli_version'),
    storePath: text('store_path'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantUserIdx: index('device_tenant_user_idx').on(table.tenantId, table.userId),
  }),
)

export const syncBatch = pgTable(
  'sync_batch',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    deviceId: text('device_id')
      .notNull()
      .references(() => device.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    storePath: text('store_path').notNull(),
    status: text('status').notNull().default('open'),
    objectCount: integer('object_count').notNull().default(0),
    planMissingCount: integer('plan_missing_count'),
    rowCount: integer('row_count').notNull().default(0),
    bytesUploaded: bigint('bytes_uploaded', { mode: 'bigint' }).notNull().default(0n),
    error: jsonb('error'),
    promotionReceipt: jsonb('promotion_receipt'),
    cleanupAcknowledgedAt: timestamp('cleanup_acknowledged_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantStatusIdx: index('sync_batch_tenant_status_idx').on(table.tenantId, table.status),
  }),
)

export const syncBatchObjectManifest = pgTable(
  'sync_batch_object_manifest',
  {
    batchId: text('batch_id')
      .notNull()
      .references(() => syncBatch.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    objectId: text('object_id').notNull(),
    canonicalHash: text('canonical_hash').notNull(),
    transportHash: text('transport_hash').notNull(),
    compression: text('compression').notNull(),
    uncompressedSize: bigint('uncompressed_size', { mode: 'bigint' }).notNull(),
    compressedSize: bigint('compressed_size', { mode: 'bigint' }).notNull(),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.batchId, table.tenantId, table.objectId] }),
    tenantBatchIdx: index('sync_batch_object_manifest_tenant_batch_idx').on(table.tenantId, table.batchId),
  }),
)

export const syncBatchProjectionManifest = pgTable(
  'sync_batch_projection_manifest',
  {
    batchId: text('batch_id')
      .notNull()
      .references(() => syncBatch.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.batchId, table.tenantId, table.entityType, table.entityId] }),
    tenantBatchIdx: index('sync_batch_projection_manifest_tenant_batch_idx').on(table.tenantId, table.batchId),
  }),
)

export const syncSource = pgTable(
  'sync_source',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    deviceId: text('device_id')
      .notNull()
      .references(() => device.id, { onDelete: 'cascade' }),
    sourceKind: text('source_kind').notNull(),
    sourcePath: text('source_path').notNull(),
    highWaterMark: text('high_water_mark'),
    lastBatchId: text('last_batch_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantDeviceSourceIdx: uniqueIndex('sync_source_tenant_device_path_idx').on(
      table.tenantId,
      table.deviceId,
      table.sourcePath,
    ),
  }),
)

export const remoteAuthority = pgTable(
  'remote_authority',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    deviceId: text('device_id')
      .notNull()
      .references(() => device.id, { onDelete: 'cascade' }),
    storePath: text('store_path').notNull(),
    promotionReceipt: jsonb('promotion_receipt').notNull(),
    cleanupCompletedAt: timestamp('cleanup_completed_at', { withTimezone: true }),
    promotedAt: timestamp('promoted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantStoreIdx: uniqueIndex('remote_authority_tenant_store_idx').on(table.tenantId, table.storePath),
  }),
)
