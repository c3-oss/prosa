# Sanitized Parquet Exports

## Goal

Support Parquet exports that are safer to share outside the local machine by
removing or transforming sensitive content.

## Current State

Parquet exports currently mirror canonical tables. They can include paths,
commands, prompts, previews, metadata, source file references, and object IDs
that may reveal private information. The README already warns users to review
data before sharing exports.

## Proposed Modes

- `metadata`: keep structural metadata, counts, timestamps, source tools,
  statuses, and canonical tool types; remove text and command contents.
- `redacted`: keep useful previews, but redact path-like strings, secrets, and
  obvious private tokens.
- `hashed`: replace stable identifiers such as session IDs, project IDs, paths,
  and source IDs with deterministic hashes.
- `allowlist`: export only selected tables and columns.

These modes can be exposed through `prosa export parquet --sanitize <mode>` or a
separate command if the option surface grows.

## Implementation Notes

Sanitization should happen while creating the Parquet export, not by mutating
SQLite/CAS. The default export should remain faithful to the canonical tables.

The implementation should be conservative. If a field is likely to contain user
content, source code, command arguments, filesystem paths, URLs, or secrets, the
sanitized export should drop or transform it unless explicitly allowed.

## Acceptance Criteria

- Sanitized export never modifies the canonical bundle.
- Documentation explains what each mode keeps and removes.
- Tests verify that known sensitive fields are removed or transformed.
- Manifest records the sanitize mode and any hash salt strategy.

## Risks

No sanitizer can guarantee perfect removal of private data from arbitrary text.
Documentation and CLI output should state this clearly and avoid implying that
sanitized exports are safe for every sharing scenario.

