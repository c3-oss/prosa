import packageJson from '../../package.json' with { type: 'json' }

/**
 * Parser/projection version for normalized importer output.
 *
 * Bump when importer or normalizer semantics change in a way that can make
 * existing canonical rows stale relative to preserved raw records. Stored on
 * every `import_batches` row for future re-projection decisions.
 */
export const PROSA_PARSER_VERSION = packageJson.version

/**
 * Current SQLite schema version, matching the highest migration in
 * `src/core/schema`.
 */
export const PROSA_SCHEMA_VERSION = 4
