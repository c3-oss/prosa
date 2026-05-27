// Postgres v2 schema — devices.
//
// Lean profile: tenant scoping is `(tenant_id, ...)` everywhere. Device
// keys are reserved for v2.x (server-only signing in v2.0) but the
// table is present so future migrations don't reshape existing rows.

export const DEVICES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS device (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  platform     TEXT NOT NULL,
  cli_version  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, name)
);

CREATE INDEX IF NOT EXISTS device_tenant_user_idx ON device (tenant_id, user_id);

-- Schema reserved for v2.x device-key signing; not used in v2.0.
CREATE TABLE IF NOT EXISTS device_public_key (
  tenant_id              TEXT NOT NULL,
  device_id              TEXT NOT NULL,
  key_id                 TEXT NOT NULL,
  alg                    TEXT NOT NULL DEFAULT 'Ed25519',
  public_key             BYTEA NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_from             TIMESTAMPTZ NOT NULL,
  valid_until            TIMESTAMPTZ,
  revoked_at             TIMESTAMPTZ,
  superseded_by_key_id   TEXT,
  PRIMARY KEY (tenant_id, device_id, key_id)
);

CREATE INDEX IF NOT EXISTS device_public_key_tenant_idx
  ON device_public_key (tenant_id, device_id);
`
