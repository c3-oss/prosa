/**
 * Idempotent SQL bootstrap for the prosa server database. This avoids
 * pulling in `drizzle-kit` at runtime to keep the surface dependency-light;
 * production deployments still run versioned `drizzle-kit` migrations
 * (see `drizzle/` directory under `apps/api`). This helper is the
 * minimum-viable path used by tests and `fs`/pglite-backed local dev.
 */

export const SCHEMA_SQL: string = `
CREATE TABLE IF NOT EXISTS "user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "session" (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  active_organization_id text
);
CREATE UNIQUE INDEX IF NOT EXISTS session_token_idx ON "session"(token);

CREATE TABLE IF NOT EXISTS "account" (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "verification" (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "organization" (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text UNIQUE,
  logo text,
  metadata text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "member" (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "invitation" (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'member',
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  inviter_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "device_code" (
  id text PRIMARY KEY,
  user_code text NOT NULL UNIQUE,
  device_code text NOT NULL UNIQUE,
  user_id text,
  client_id text,
  scope text,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  last_polled_at timestamptz,
  polling_interval text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "jwks" (
  id text PRIMARY KEY,
  public_key text NOT NULL,
  private_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "device" (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name text NOT NULL,
  platform text,
  cli_version text,
  store_path text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_tenant_user_idx ON "device"(tenant_id, user_id);

CREATE TABLE IF NOT EXISTS "sync_batch" (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES "device"(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  store_path text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  object_count integer NOT NULL DEFAULT 0,
  plan_missing_count integer,
  row_count integer NOT NULL DEFAULT 0,
  bytes_uploaded bigint NOT NULL DEFAULT 0,
  error jsonb,
  promotion_receipt jsonb,
  cleanup_acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_batch_tenant_status_idx ON "sync_batch"(tenant_id, status);
ALTER TABLE "sync_batch" ADD COLUMN IF NOT EXISTS store_path text;
ALTER TABLE "sync_batch" ADD COLUMN IF NOT EXISTS plan_missing_count integer;

CREATE TABLE IF NOT EXISTS "sync_batch_object_manifest" (
  batch_id text NOT NULL REFERENCES "sync_batch"(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  object_id text NOT NULL,
  canonical_hash text NOT NULL,
  transport_hash text NOT NULL,
  compression text NOT NULL,
  uncompressed_size bigint NOT NULL,
  compressed_size bigint NOT NULL,
  storage_key text NOT NULL,
  content_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, tenant_id, object_id)
);
CREATE INDEX IF NOT EXISTS sync_batch_object_manifest_tenant_batch_idx
  ON "sync_batch_object_manifest"(tenant_id, batch_id);

CREATE TABLE IF NOT EXISTS "sync_batch_projection_manifest" (
  batch_id text NOT NULL REFERENCES "sync_batch"(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, tenant_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS sync_batch_projection_manifest_tenant_batch_idx
  ON "sync_batch_projection_manifest"(tenant_id, batch_id);

CREATE TABLE IF NOT EXISTS "sync_source" (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES "device"(id) ON DELETE CASCADE,
  source_kind text NOT NULL,
  source_path text NOT NULL,
  high_water_mark text,
  last_batch_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_source_tenant_device_path_idx ON "sync_source"(tenant_id, device_id, source_path);

CREATE TABLE IF NOT EXISTS "remote_authority" (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES "device"(id) ON DELETE CASCADE,
  store_path text NOT NULL,
  promotion_receipt jsonb NOT NULL,
  cleanup_completed_at timestamptz,
  promoted_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS remote_authority_tenant_store_idx ON "remote_authority"(tenant_id, store_path);

CREATE TABLE IF NOT EXISTS "remote_object" (
  object_id text PRIMARY KEY,
  hash text NOT NULL,
  hash_algorithm text NOT NULL DEFAULT 'blake3',
  compression text NOT NULL DEFAULT 'zstd',
  uncompressed_size bigint NOT NULL,
  compressed_size bigint NOT NULL,
  storage_key text UNIQUE,
  content_type text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS remote_object_hash_idx ON "remote_object"(hash);
ALTER TABLE "remote_object" ALTER COLUMN storage_key DROP NOT NULL;

CREATE TABLE IF NOT EXISTS "remote_blob" (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE RESTRICT,
  batch_id text REFERENCES "sync_batch"(id) ON DELETE SET NULL,
  storage_key text NOT NULL UNIQUE,
  hash text NOT NULL,
  hash_algorithm text NOT NULL DEFAULT 'blake3',
  byte_size bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS remote_blob_tenant_batch_idx ON "remote_blob"(tenant_id, batch_id);

CREATE TABLE IF NOT EXISTS "remote_object_location" (
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  object_id text NOT NULL REFERENCES "remote_object"(object_id) ON DELETE CASCADE,
  batch_id text REFERENCES "sync_batch"(id) ON DELETE SET NULL,
  location_type text NOT NULL,
  blob_id text REFERENCES "remote_blob"(id) ON DELETE RESTRICT,
  storage_key text,
  byte_offset bigint NOT NULL DEFAULT 0,
  byte_length bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, object_id),
  CHECK (
    (location_type = 'object' AND storage_key IS NOT NULL AND blob_id IS NULL)
    OR (location_type = 'pack' AND blob_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS remote_object_location_blob_range_idx
  ON "remote_object_location"(blob_id, byte_offset);
CREATE INDEX IF NOT EXISTS remote_object_location_storage_key_idx
  ON "remote_object_location"(storage_key) WHERE storage_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS "tenant_object" (
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  object_id text NOT NULL REFERENCES "remote_object"(object_id) ON DELETE RESTRICT,
  first_batch_id text REFERENCES "sync_batch"(id) ON DELETE SET NULL,
  ref_count integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, object_id)
);

CREATE TABLE IF NOT EXISTS "source_file" (
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  id text NOT NULL,
  source_kind text NOT NULL,
  path text NOT NULL,
  size_bytes bigint,
  mtime_iso timestamptz,
  content_hash text,
  decoded_object_id text,
  parser_status text,
  confidence text,
  import_batch_id text,
  object_id text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, object_id)
    REFERENCES "tenant_object"(tenant_id, object_id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, decoded_object_id)
    REFERENCES "tenant_object"(tenant_id, object_id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS source_file_path_idx ON "source_file"(tenant_id, path);

CREATE TABLE IF NOT EXISTS "import_batch" (
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  id text NOT NULL,
  sync_batch_id text REFERENCES "sync_batch"(id) ON DELETE SET NULL,
  source_kind text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  session_count integer NOT NULL DEFAULT 0,
  record_count integer NOT NULL DEFAULT 0,
  metadata jsonb,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS "raw_record" (
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  id text NOT NULL,
  source_file_id text NOT NULL,
  sequence integer NOT NULL,
  payload jsonb NOT NULL,
  object_id text,
  decoded_object_id text,
  parser_status text,
  confidence text,
  import_batch_id text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, source_file_id)
    REFERENCES "source_file"(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, object_id)
    REFERENCES "tenant_object"(tenant_id, object_id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, decoded_object_id)
    REFERENCES "tenant_object"(tenant_id, object_id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS raw_record_source_idx ON "raw_record"(tenant_id, source_file_id, sequence);

CREATE TABLE IF NOT EXISTS "project" (
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  source_path text,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS "projection_session" (
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  id text NOT NULL,
  source_kind text NOT NULL,
  project_id text,
  title text,
  started_at timestamptz,
  ended_at timestamptz,
  turn_count integer NOT NULL DEFAULT 0,
  metadata jsonb,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS projection_session_started_idx ON "projection_session"(tenant_id, started_at);
CREATE INDEX IF NOT EXISTS projection_session_source_idx ON "projection_session"(tenant_id, source_kind);

CREATE TABLE IF NOT EXISTS "projection_turn" (
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  id text NOT NULL,
  session_id text NOT NULL,
  sequence integer NOT NULL,
  role text NOT NULL,
  started_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES "projection_session"(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS projection_turn_session_idx ON "projection_turn"(tenant_id, session_id, sequence);

CREATE TABLE IF NOT EXISTS "projection_event" (
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  id text NOT NULL,
  session_id text NOT NULL,
  turn_id text,
  sequence integer NOT NULL,
  kind text NOT NULL,
  payload jsonb,
  occurred_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES "projection_session"(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS projection_event_session_idx ON "projection_event"(tenant_id, session_id, sequence);

CREATE TABLE IF NOT EXISTS "projection_message" (
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  id text NOT NULL,
  session_id text NOT NULL,
  turn_id text,
  role text NOT NULL,
  model text,
  created_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES "projection_session"(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS "projection_content_block" (
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  id text NOT NULL,
  message_id text NOT NULL,
  sequence integer NOT NULL,
  kind text NOT NULL,
  text text,
  object_id text,
  metadata jsonb,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, message_id)
    REFERENCES "projection_message"(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, object_id)
    REFERENCES "tenant_object"(tenant_id, object_id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS projection_content_block_message_idx ON "projection_content_block"(tenant_id, message_id, sequence);

CREATE TABLE IF NOT EXISTS "projection_tool_call" (
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  id text NOT NULL,
  session_id text NOT NULL,
  turn_id text,
  name text NOT NULL,
  status text,
  input_object_id text,
  created_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES "projection_session"(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, input_object_id)
    REFERENCES "tenant_object"(tenant_id, object_id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS "projection_tool_result" (
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  id text NOT NULL,
  tool_call_id text NOT NULL,
  output_object_id text,
  status text,
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, tool_call_id)
    REFERENCES "projection_tool_call"(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, output_object_id)
    REFERENCES "tenant_object"(tenant_id, object_id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS "projection_artifact" (
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  id text NOT NULL,
  session_id text,
  kind text NOT NULL,
  object_id text,
  size_bytes bigint,
  metadata jsonb,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, object_id)
    REFERENCES "tenant_object"(tenant_id, object_id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS "projection_edge" (
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  id text NOT NULL,
  session_id text,
  source_id text NOT NULL,
  target_id text NOT NULL,
  relation text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS projection_edge_idx ON "projection_edge"(tenant_id, source_id, target_id, relation);

CREATE TABLE IF NOT EXISTS "search_doc" (
  tenant_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  id text NOT NULL,
  session_id text NOT NULL,
  kind text NOT NULL,
  body text NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES "projection_session"(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS search_doc_session_idx ON "search_doc"(tenant_id, session_id);
`

export type ExecutableSqlClient = {
  exec: (sql: string) => Promise<unknown>
}

export async function applySchema(client: ExecutableSqlClient): Promise<void> {
  await client.exec(SCHEMA_SQL)
}
