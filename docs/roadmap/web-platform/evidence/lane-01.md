# Lane Evidence

Lane: 01 Product surface and visual system
Status: complete
Owner: Ralph
Commit range: HEAD of master once committed

## Acceptance Criteria

- [x] AC-001 Public, auth, and console routes are specified before frontend
  work depends on them (`docs/roadmap/web-platform/01-product-surface.md` lists
  every route, marketing + auth + console, and explicitly names deferred
  routes).
- [x] AC-002 Visual tokens, typography, layout primitives, and component names
  are defined and used as the source for `apps/web/src/styles/tokens.css`,
  `global.css`, and the component vocabulary list.
- [x] AC-003 Console is explicitly tenant-scoped and assumes remote/promoted
  data; the spec forbids local bundle browsing in web v0 and forbids fake
  console data.
- [x] AC-004 Public site and console share one design language with different
  density (editorial marketing vs dense operational console), encoded in two
  separate stylesheets `marketing.css` and `console.css`.
- [x] AC-005 Deferred routes (`/pricing`, `/console/imports`, `/console/mcp`)
  and out-of-scope surfaces (Parquet/DuckDB, MCP management, browser-triggered
  compile/import) are documented.

## Implementation Notes

- The product surface document is the binding contract for later lanes.
- Tokens defined in `01-product-surface.md` are mirrored 1:1 in
  `apps/web/src/styles/tokens.css`.
- Routes defined here are mirrored in TanStack Router route declarations under
  `apps/web/src/routes`.
- Component vocabulary defined here is the naming source for components under
  `apps/web/src/components`.

## Commands Run

```text
git status --short --branch        (clean against master at kickoff)
git diff --check docs/             (no whitespace errors in roadmap docs)
```

## Data / Security Evidence

- The product spec hard-codes tenant scoping for every console route.
- The spec hard-codes verified-promoted-data assumption for console reads.
- The spec forbids storing session tokens, auth headers, invite links, or
  cookies in localStorage, logs, or fixtures.
- The spec keeps Parquet/DuckDB/MCP/compile out of the browser.

## Known Risks

- The lane is documentation-first; if later implementation reveals a missing
  decision, that gap must be filed as a correction in `correction-queue.md`
  and the roadmap doc must be updated before code depends on the new decision.

## Reviewer Notes

- Codex review of lane 01: the product spec is decision-complete enough for
  lane 02 implementation. Any ambiguity must round-trip through the roadmap
  doc, not the code.
