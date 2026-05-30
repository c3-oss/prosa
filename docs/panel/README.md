# Docs: prosa-panel

Design and surface documentation for the `prosa-panel` binary. For
implementation internals see
[`../architecture/panel.md`](../architecture/panel.md).

## Index

- [Design brief](design-brief.md) — central direction, visual language,
  list of requested mocks.
- [Screens](screens.md) — screen-by-screen spec: layout, data shown,
  behavior.
- [Components](components.md) — KPI card, SVG charts, filter pills,
  command palette, design tokens.
- [Mock prompts](mock-prompts.md) — ready-to-use prompts for generating
  visual mocks with AI (Claude artifacts, v0.dev, Midjourney, etc).

## Stack (summary)

- Go + `html/template` + `embed.FS` — server-rendered, single binary.
- HTMX — partial swaps (sidepanel, raw pagination, chart swaps by
  filter).
- Alpine.js (~15 KB) — local UI state (toggle, modal, hover).
- Inline SVG generated in Go (`internal/panel/charts/`) — sparkline, bar,
  donut, heatmap, trend.
- Modular CSS via native `@import`, no build step.
- SSE — live updates (new-sessions badge, KPI tick-up).

## Philosophy

- Single binary, zero build step, zero `node_modules`.
- Server-first: data state on the server, UI state on the client.
- Airy > dense. Clear > impressive.
- Adding visual weight requires justification.

## When to update this set of docs

When a design decision affects:

- screen structure (moving blocks, changing layout) → update `screens.md`;
- a reusable component (create, change, remove) → update `components.md`;
- visual language (palette, typography, spacing, motion) → update the
  [design brief](design-brief.md);
- you want to test a variation with AI before coding → write the prompt
  in `mock-prompts.md` and ship it to AI first.

Concrete implementation details live in `cmd/prosa-panel/` and
`internal/panel/`, and are documented in
[`../architecture/panel.md`](../architecture/panel.md). Don't duplicate
those here.
