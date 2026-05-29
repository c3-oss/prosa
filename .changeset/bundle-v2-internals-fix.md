---
'@c3-oss/prosa': patch
---

Bundle internal v2 workspace packages into the CLI dist so `npm i -g @c3-oss/prosa` resolves.

`@c3-oss/prosa@0.10.0` shipped with `dependencies` on five private workspace
packages (`prosa-bundle-v2`, `prosa-derived-v2`, `prosa-importers-v2`,
`prosa-types-v2`, `prosa-wire-v2`) that were never published, so npm install
failed with `404 Not Found` on the first transitive lookup.

This patch:

- Adds `noExternal` for those five packages to `apps/cli/tsup.config.ts`, so
  their code is inlined into `dist/bin/prosa.js`.
- Marks the transitive native bindings (`@duckdb/node-api`, `better-sqlite3`,
  `@oxdev03/node-tantivy-binding`, `zstd-napi`) and JS-only siblings
  (`@noble/hashes`, `zod`) as `external` so tsup does not try to bundle native
  `.node` files and platform-specific optional deps.
- Moves the five v2 workspace packages from `dependencies` to
  `devDependencies` (they only need to be present at build time now), and
  promotes the native bindings to runtime `dependencies` so the published CLI
  declares everything it imports.

`@c3-oss/prosa-core` continues to be published independently and stays
external.
