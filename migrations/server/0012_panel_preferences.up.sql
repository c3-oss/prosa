-- Panel UI preferences (e.g. theme) keyed by owner email. Server-only:
-- the panel reads/writes these via PreferencesService, never the CLI.
CREATE TABLE panel_preferences (
  owner_email TEXT        NOT NULL,
  pref_key    TEXT        NOT NULL,
  pref_value  TEXT        NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_email, pref_key)
);
