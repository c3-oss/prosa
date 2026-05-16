// Loaded at runtime by core/schema/migrate.ts.

/**
 * Add the optional transport hash cached for object upload bodies.
 *
 * `objects.hash` remains the canonical uncompressed BLAKE3 digest. This column
 * stores the BLAKE3 digest of the bytes sent over sync transport, which may be
 * compressed bytes for zstd-backed objects.
 */
export const SQL_005_OBJECT_TRANSPORT_HASH = String.raw`
-- Schema W v5

ALTER TABLE objects ADD COLUMN transport_hash TEXT;
`
