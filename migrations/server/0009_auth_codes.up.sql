-- Replace device_codes (device-code flow) with auth_codes (PKCE + localhost callback).

DROP TABLE IF EXISTS device_codes;

CREATE TABLE auth_codes (
    request_id            TEXT PRIMARY KEY,
    code                  TEXT UNIQUE,
    code_challenge        TEXT NOT NULL,
    code_challenge_method TEXT NOT NULL DEFAULT 'S256',
    redirect_uri          TEXT NOT NULL,
    client_state          TEXT NOT NULL,
    hostname              TEXT NOT NULL,
    fingerprint           TEXT NOT NULL,
    state                 TEXT NOT NULL,
    expires_at            TIMESTAMPTZ NOT NULL,
    approved_at           TIMESTAMPTZ,
    used_at               TIMESTAMPTZ
);

CREATE INDEX auth_codes_code_idx ON auth_codes (code) WHERE code IS NOT NULL;
CREATE INDEX auth_codes_expires_at_idx ON auth_codes (expires_at);
