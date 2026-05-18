import { bigint, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'
import { organization } from './auth.js'
import { remoteObject } from './objects.js'
import { syncBatch } from './sync.js'

/**
 * Canonical projection rows for promoted sessions. Mirrors the local
 * SQLite schema described in docs/architecture/bundle-format.md, scoped
 * by tenant.
 */

export const sourceFile = pgTable(
  'source_file',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    sourceKind: text('source_kind').notNull(),
    path: text('path').notNull(),
    objectId: text('object_id').references(() => remoteObject.objectId, { onDelete: 'set null' }),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb('metadata'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.id] }),
    pathIdx: index('source_file_path_idx').on(table.tenantId, table.path),
  }),
)

export const importBatch = pgTable(
  'import_batch',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    syncBatchId: text('sync_batch_id').references(() => syncBatch.id, { onDelete: 'set null' }),
    sourceKind: text('source_kind').notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
    sessionCount: integer('session_count').notNull().default(0),
    recordCount: integer('record_count').notNull().default(0),
    metadata: jsonb('metadata'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.id] }),
  }),
)

export const rawRecord = pgTable(
  'raw_record',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    sourceFileId: text('source_file_id').notNull(),
    sequence: integer('sequence').notNull(),
    payload: jsonb('payload').notNull(),
    objectId: text('object_id').references(() => remoteObject.objectId, { onDelete: 'set null' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.id] }),
    sourceIdx: index('raw_record_source_idx').on(table.tenantId, table.sourceFileId, table.sequence),
  }),
)

export const project = pgTable(
  'project',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    name: text('name').notNull(),
    sourcePath: text('source_path'),
  },
  (table) => ({ pk: primaryKey({ columns: [table.tenantId, table.id] }) }),
)

export const session = pgTable(
  'projection_session',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    sourceKind: text('source_kind').notNull(),
    projectId: text('project_id'),
    title: text('title'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    turnCount: integer('turn_count').notNull().default(0),
    parentSessionId: text('parent_session_id'),
    isSubagent: integer('is_subagent').notNull().default(0),
    agentRole: text('agent_role'),
    agentNickname: text('agent_nickname'),
    metadata: jsonb('metadata'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.id] }),
    startedIdx: index('projection_session_started_idx').on(table.tenantId, table.startedAt),
    sourceIdx: index('projection_session_source_idx').on(table.tenantId, table.sourceKind),
    subagentIdx: index('projection_session_subagent_idx').on(table.tenantId, table.isSubagent, table.startedAt),
  }),
)

export const turn = pgTable(
  'projection_turn',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    sessionId: text('session_id').notNull(),
    sequence: integer('sequence').notNull(),
    role: text('role').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.id] }),
    sessionIdx: index('projection_turn_session_idx').on(table.tenantId, table.sessionId, table.sequence),
  }),
)

export const event = pgTable(
  'projection_event',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id'),
    sequence: integer('sequence').notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.id] }),
    sessionIdx: index('projection_event_session_idx').on(table.tenantId, table.sessionId, table.sequence),
  }),
)

export const message = pgTable(
  'projection_message',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id'),
    role: text('role').notNull(),
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }),
  },
  (table) => ({ pk: primaryKey({ columns: [table.tenantId, table.id] }) }),
)

export const contentBlock = pgTable(
  'projection_content_block',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    messageId: text('message_id').notNull(),
    sequence: integer('sequence').notNull(),
    kind: text('kind').notNull(),
    text: text('text'),
    tokenCount: integer('token_count'),
    objectId: text('object_id').references(() => remoteObject.objectId, { onDelete: 'set null' }),
    metadata: jsonb('metadata'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.id] }),
    messageIdx: index('projection_content_block_message_idx').on(table.tenantId, table.messageId, table.sequence),
  }),
)

export const toolCall = pgTable(
  'projection_tool_call',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id'),
    name: text('name').notNull(),
    status: text('status'),
    inputObjectId: text('input_object_id').references(() => remoteObject.objectId, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }),
  },
  (table) => ({ pk: primaryKey({ columns: [table.tenantId, table.id] }) }),
)

export const toolResult = pgTable(
  'projection_tool_result',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    toolCallId: text('tool_call_id').notNull(),
    outputObjectId: text('output_object_id').references(() => remoteObject.objectId, { onDelete: 'set null' }),
    status: text('status'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => ({ pk: primaryKey({ columns: [table.tenantId, table.id] }) }),
)

export const artifact = pgTable(
  'projection_artifact',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    sessionId: text('session_id'),
    kind: text('kind').notNull(),
    objectId: text('object_id').references(() => remoteObject.objectId, { onDelete: 'set null' }),
    sizeBytes: bigint('size_bytes', { mode: 'bigint' }),
    metadata: jsonb('metadata'),
  },
  (table) => ({ pk: primaryKey({ columns: [table.tenantId, table.id] }) }),
)

export const edge = pgTable(
  'projection_edge',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    sessionId: text('session_id'),
    sourceId: text('source_id').notNull(),
    targetId: text('target_id').notNull(),
    relation: text('relation').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.id] }),
    edgeIdx: index('projection_edge_idx').on(table.tenantId, table.sourceId, table.targetId, table.relation),
  }),
)

export const searchDoc = pgTable(
  'search_doc',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    sessionId: text('session_id').notNull(),
    kind: text('kind').notNull(),
    body: text('body').notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.id] }),
    sessionIdx: index('search_doc_session_idx').on(table.tenantId, table.sessionId),
  }),
)
