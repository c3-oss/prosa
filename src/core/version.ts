// Bumped every time the importer/normalizer makes a breaking change in how
// raw records are projected into the canonical tables. Stored on every
// import_batch row so we know which batches are stale and need re-projection.
export const PROSA_PARSER_VERSION = '0.1.0';

// Schema version bumped per migration file in core/schema/.
export const PROSA_SCHEMA_VERSION = 4;
