---
name: prosa-panel-rendering
description: Panel behavior and rendering conventions for prosa. Use when changing internal/panel templates, HTMX partials, Alpine state, Frappe charts, CSS tokens, or OAuth flow.
---

# Prosa Panel Rendering

Use this skill before changing the panel's HTML, templates, or
client-side behavior.

## Stack

- **Go + `html/template` + `embed.FS`** — server-rendered, single binary,
  no build step.
- **HTMX** — partial swaps for the sidepanel and raw transcript
  pagination today; chart filter swaps as the panel grows.
- **Alpine.js (~15 KB)** — local UI state only: toggles, modals, hover,
  filter pill open/close, command palette. Not for data fetching.
- **Charts via Frappe Charts** (vendored ~19 KB SVG library). The server
  builds a `charts.Spec` in `internal/panel/charts/` and emits it as a
  JSON island; `assets/charts-init.js` renders it client-side with the
  `--chart-*` palette. The heatmap / punch card stay CSS-grid (HTML, not
  a chart library). Bar leaderboards stay server-rendered HTML.
- **CSS in modules** under `internal/panel/templates/assets/css/`,
  imported via native `@import`. No bundler.
- **SSE** at `/events` — live badge of new sessions; future live KPI
  ticks.

The full surface is documented in `docs/architecture/panel.md`. The
design contract is in `docs/panel/screens.md` and
`docs/panel/components.md`.

## Rules

- **No build step.** No esbuild, no vite, no `npm install`. Everything
  ships via `embed.FS`.
- **No SPA patterns.** No client-side router. No global store. No
  hydration.
- **Server-first state.** Data state lives on the server; UI state lives
  on the client. The dividing line is HTMX (server data) versus Alpine
  (UI toggles).
- **Charts via Frappe Charts only.** Build a `charts.Spec` in
  `internal/panel/charts/` and let `charts-init.js` render it; don't add a
  second charting library (Chart.js / D3 / ECharts / …). Vendoring the one
  prebuilt UMD file via `embed.FS` is not a build step; adding `npm` /
  a bundler still is, and is out.
- **Design tokens are the only colors.** `tokens.css` defines `--bg`,
  `--text-*`, `--accent`, `--ok`, `--danger`, etc. Templates reference
  vars; nobody else uses literal hex.
- **Templates compose via `base.html`.** Per-view templates are parsed
  bundled with the base layout at startup
  (`internal/panel/server.go`); execute by view name.
- **Auth shapes are public contract.** OAuth cookie is HMAC-signed
  (`PROSA_PANEL_COOKIE_KEY`), `HttpOnly`, `Secure` when configured,
  `SameSite=Lax`. `PROSA_PANEL_DEV_LOGIN` is dev-only and logs a loud
  warning at boot.

## Routes (current)

Public: `/healthz`, `/login`, `/oauth/github/callback`, `/logout`,
`/dev-login` (only when env set), `/assets/*`.

Gated by session cookie: `/`, `/sessions/<id>` (HTMX partial),
`/raw/<id>?offset=N` (HTMX append), `/devices`, `/devices/<id>/rename`,
`/devices/<id>/revoke`, `/cli/authorize`, `/cli/authorize/approve`, `/analytics/<report>`,
`/events` (SSE proxy).

## Adding something

- **New route**: register in `server.go`. Decide gated vs public.
  Document in `docs/architecture/panel.md`.
- **New template**: add to `internal/panel/templates/`. If top-level,
  add to `loadViews()`.
- **New chart**: build a `charts.Spec` in `internal/panel/charts/` (pick a
  Frappe type: bar/line/donut/axis-mixed), unit-test the JSON shape in
  `spec_test.go`, render it from the handler, and add a `[data-chart]`
  container + JSON island in the template. Verify visually; there are no
  golden SVGs anymore.
- **New env var**: add to `internal/panel/config.go` and document in
  `docs/self-hosting.md`.
- **New static asset**: drop into `templates/assets/`. `embed.FS` picks
  it up on rebuild.

## Testing

- Smoke render: stand up the panel with `PROSA_PANEL_DEV_LOGIN`
  set, hit `/`, click through to the sidepanel, hit `Esc`.
- Template parse: `go test ./internal/panel/...`.
- Chart spec shape: `go test ./internal/panel/charts/...`.
- Full lane: `just test-race`.

## See also

- `docs/architecture/panel.md` — internals, routes, auth, SSE proxy.
- `docs/panel/design-brief.md` — direction, palette, motion.
- `docs/panel/screens.md` — screen-by-screen layout.
- `docs/panel/components.md` — KPI, charts, filter pills, command
  palette, design tokens.
- `docs/self-hosting.md` — env vars and OAuth setup for owners.
