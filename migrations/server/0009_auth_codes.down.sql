DROP TABLE IF EXISTS auth_codes;

CREATE TABLE device_codes (
    device_code TEXT PRIMARY KEY,
    user_code   TEXT NOT NULL UNIQUE,
    state       TEXT NOT NULL,
    hostname    TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    approved_at TIMESTAMPTZ
);
