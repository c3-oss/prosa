# Architecture: panel

How `prosa-panel` is built internally. For the user-facing screens and
visual design see [`../panel/`](../panel/). For deployment see
[`../self-hosting.md`](../self-hosting.md).

## What the panel is

A small server-rendered web app:

- **Go** + `html/template` (stdlib), no templ.
- **`embed.FS`** — every HTML, CSS, JS, and image asset ships inside the
  binary. There is no build step, no `node_modules`, no bundler.
- **HTMX** for partial swaps (session detail sidepanel, raw-transcript
  pagination).
- **Alpine.js** (~44 KB) for client-only UI state (modal toggles,
  filter pill open/close, command palette).
- **Server-rendered HTML bars + tables** for leaderboard cards, and a
  CSS-grid heatmap / punch card. The analytics charts (cost-share donut,
  hour-of-day + token area, activity-trend + spend bars, normalized
  model-share) render client-side with **Frappe Charts** — a vendored,
  zero-dependency SVG charting library (~19 KB gzip, MIT) embedded via
  `embed.FS` exactly like htmx/alpine, so there is still no build step,
  no `node_modules`, no bundler. The server emits each chart as a JSON
  island built by `internal/panel/charts` (`Spec.JSON`);
  `assets/charts-init.js` reads it, resolves series colors from the
  `--chart-*` CSS tokens (so a theme swap recolors charts), and draws it
  with animation + hover tooltips. Vendoring a prebuilt UMD file is **not**
  a build step.
- **SSE** for live updates (badge of new sessions; future live KPI
  ticks).
- **Connect-Go client** to talk to `prosa-server`. The panel does not touch
  Postgres or S3 directly.

The panel is single-binary distributable. `go build ./cmd/prosa-panel`
produces a runnable artifact with all assets embedded.

## Entry point

`cmd/prosa-panel/main.go` is thin. It calls `panel.New(cfg)` and
`Serve(ctx)`, both defined in `internal/panel/`.

```
cmd/prosa-panel/main.go                 thin entrypoint
└─ internal/panel/server.go             http mux, route registration, view parsing
   ├─ internal/panel/rpc/client.go      Connect clients for the server's services
   ├─ internal/panel/handlers/          per-route handlers
   ├─ internal/panel/session/           cookie signing
   ├─ internal/panel/templates/         HTML templates via embed.FS
   ├─ internal/panel/assets/            JS, CSS, fonts via embed.FS
   └─ internal/panel/config.go          env-driven configuration
```

## Configuration

Env-driven, no CLI flags. The full list is in
[`../self-hosting.md`](../self-hosting.md). Highlights:

- `PROSA_PANEL_LISTEN_ADDR` (default `:8080`)
- `PROSA_PANEL_SERVER_URL` (default `http://localhost:7070`)
- `PROSA_ADMIN_TOKEN` — used to talk to the server as the owner
- `PROSA_PANEL_OAUTH_GH_CLIENT_ID`, `PROSA_PANEL_OAUTH_GH_SECRET`
- `PROSA_PANEL_PUBLIC_URL` — for OAuth callback construction
- `PROSA_PANEL_COOKIE_KEY` — HMAC key, ≥ 32 bytes hex
- `PROSA_PANEL_COOKIE_SECURE` — `true` behind HTTPS
- `PROSA_OWNER_EMAILS` — CSV whitelist
- `PROSA_PANEL_DEV_LOGIN` — dev bypass; loud warning on boot

## HTTP shape

Stdlib `net/http` and `http.ServeMux`. There is no third-party router
(chi, gorilla, gin). Connect-Go RPC is used only on the **client** side to
talk to `prosa-server`.

Routes (current MVP cut), all served from the same mux:

**Public:**
- `GET /healthz`
- `GET /login`
- `GET /oauth/github/callback`
- `POST /dev-login` (only when `PROSA_PANEL_DEV_LOGIN` is set)
- `GET /assets/*` — embedded static assets

**Gated by session cookie:**
- `GET /` — Home dashboard (KPI strip with vs-previous-window deltas + heatmap + activity-trend card + tools/models/projects/hour-of-day cards, the Issues section, tokens-&-cost-per-model and usage cards, collapsible filters)
- `GET /insights` — progression & rhythm dashboard (spend & tokens per day, weekly model share, weekday × hour punch card, hour-of-day model/token breakdown, streak/consistency and schedule KPIs, session-duration histogram, the Delegation section with fan-out and top delegators, the agentic-session-kinds card; same filter chrome as Home)
- `GET /sessions` — full session list (FTS, multi-select filters including a Kind filter for special-session classifications, column chooser, sortable headers, paginated). Kind badges (goal / workflow / ralph-loop / orchestrator) render beside the agent badge.
- `GET /sessions/<id>` — session detail (HTMX side-panel partial). Kind badges show in the header; a Codex goal session renders its `<objective>` as the prompt body with the budget and scaffold as disclosures.
- `GET /projects` — projects table; rows link into filtered Sessions
- `GET /profiles` — profile analytics dashboard (KPIs, sessions-per-profile trend, tokens & cost per profile, device × agent × profile table; same filter chrome as Home)
- `GET /devices` — device admin; Hostname cells link into filtered Sessions
- `POST /devices/<id>/rename`
- `POST /devices/<id>/revoke`
- `GET /settings` — identity, logout, appearance, and preference controls
- `POST /settings/theme` — save the owner theme preference
- `POST /settings/window` — save the owner default time-window preference
- `POST /settings/reset` — reset panel UI preferences
- `GET /raw/<id>?offset=N` — raw transcript chunk (HTMX append-mode)
- `GET /cli/authorize` — CLI login confirmation (session required)
- `POST /cli/authorize/approve` — approve CLI device, redirect to localhost callback
- `POST /logout` — clear the panel session
- `GET /events` — SSE stream (proxied from the server)

There is no `/analytics/*` surface. The reports live as cards on three
dashboards: Home (Tools, Models, Projects, Hour of day, Issues,
Tokens & cost per model, Usage, the Heatmap, and the Activity trend),
Insights (spend & tokens trend, model share, punch card, across the
day, streaks, durations, delegation, fan-out, top delegators), and
Profiles (sessions-per-profile trend, tokens & cost per profile, the
by-device table); the per-report subpages were folded into the
dashboards and into the filtered Sessions list.

Note: `/sessions` (exact) and `/sessions/<id>` (subtree prefix) coexist
on the stdlib `http.ServeMux` — list vs. detail are independent
patterns, longest-match first. Don't tighten the registration without
keeping both alive.

Each handler:

1. Validates the session cookie (when gated).
2. Talks to the server via Connect.
3. Renders one of the pre-parsed templates.
4. Writes the result to `http.ResponseWriter`.

## Templates

`internal/panel/templates/` contains the HTML files. Static assets
(JS, CSS, fonts) live in `internal/panel/assets/` and are embedded
separately:

```go
// internal/panel/assets/embed.go
//go:embed *.js *.css css fonts
var FS embed.FS
```

At startup, `server.loadViews()` parses each view as its own template tree
bundled with `base.html` to avoid block collisions across siblings. The
result is a map: `viewName → *template.Template`. Handlers execute the
template by name.

Current template files (likely set; check the directory for ground truth):

- `base.html` — sidebar (7 entries), main area, side panel slot.
- `home.html` — dashboard: KPI strip (with deltas) + heatmap +
  activity trend + tools/models/errors/usage cards.
- `insights.html` — progression & rhythm dashboard: spend/tokens trend,
  model share, punch card, across-the-day, streak & schedule KPIs,
  durations, delegation, fan-out, top delegators.
- `dashboard_filters.html` — shared partial: the filter drawer + active
  chips used by both dashboards (parameterized by `PageTitle` /
  `FilterAction`).
- `sessions.html` — full session list: FTS input, multi-select
  dropdowns, `<details>` column chooser, sortable headers, pagination
  footer.
- `projects.html` — table from the projects analytics report; rows link
  into `/sessions?project=<label>&last=<window>`.
- `profiles.html` — profile analytics dashboard from the profile_usage
  and profiles_by_day reports; table cells link into filtered Sessions.
- `devices.html` — device table + approval form; Hostname cells link
  into `/sessions?device=<friendly_name>`.
- `settings.html` — single card: email + logout.
- `side_panel.html` — HTMX fragment for session detail.
- `raw_chunk.html` — HTMX fragment for raw transcript pages.
- `cli_authorize.html` — CLI authorization confirmation page.
- `login.html` — OAuth + dev-login.

Helper template funcs: minimal — `hasPrefix` for active-nav matching.

## Static assets

In `internal/panel/assets/` (embedded via `assets.FS`):

- `htmx.min.js` (~50 KB) — vendored HTMX.
- `alpine.min.js` (~44 KB) — vendored Alpine.js 3.14.9 for client-only
  UI state (toggles, command palette).
- `alpine-collapse.min.js` (~1.5 KB) — Alpine `x-collapse` plugin for
  smooth open/close on `<details>`-style blocks.
- `frappe-charts.min.umd.js` (~19 KB gzip) — vendored Frappe Charts 1.6.2
  (MIT). Renders the analytics charts; self-injects its own base CSS at
  runtime (re-skinned by `css/components/charts.css`). Pinned by sha256 in
  `charts-init.js`; refresh by re-downloading the same dist file.
- `style.css` — entrypoint that `@import`s the `css/` modules and
  carries the remaining handcrafted rules.
- `css/fonts.css` — `@font-face` declarations for the three self-hosted
  families (Newsreader, Geist, Geist Mono), all `font-display: swap`,
  pointing at `../fonts/*.woff2`. No CDN or web-font requests.
- `fonts/` — latin-subset `woff2` files for Newsreader (400/500/600,
  400-italic), Geist (400/500/600), and Geist Mono (400/500), embedded
  by the `//go:embed *.js *.css css fonts` directive in `embed.go`.
- `css/tokens.css` — design tokens (Almanac palette, three font-family
  vars, type scale, spacing, radius, motion). Source of truth for color
  and rhythm.
- `css/base.css` — reset, body baseline, `:focus-visible` ring,
  `prefers-reduced-motion` overrides.
- `keyboard.js` — small keyboard handlers (`/`, `j/k`, `Esc`).
- `sse.js` — listens on `/events`, updates the "new sessions" badge.
- `widgets.js` — vanilla helpers (device dropdown, heatmap tooltip,
  inline rename).
- `charts-init.js` — reads each card's chart JSON island, resolves the
  `--chart-*` palette from CSS, and renders it with Frappe Charts;
  re-renders on `htmx:afterSettle` and on a `data-theme` flip.

Component CSS under `css/components/`:

- `sidepanel.css` — sticky header, masthead, stats cluster, Details
  metadata grid, transcript toolbar and search.
- `bubbles.css` — iMessage-style user/assistant/tool bubbles + assistant
  prose styles for markdown nodes.
- `tool-group.css` — collapsible Alpine wrapper around runs of
  `Role="tool"` turns.
- `user-bubble.css` — slash command chip + disclosure blocks for the
  XML wrappers `sessiontext.ParseUserMessage` peels off.
- `thinking.css` — discreet dashed-rule card for coalesced thinking
  runs.
- `subagents.css` — list of child sessions on the parent's sidepanel,
  HTMX-swappable to drill down.
- `kind-badge.css` — per-kind colored pills for special-session
  classifications (goal / workflow / ralph-loop / orchestrator) shown in
  the Sessions table and side-panel header.
- `insights.css` — Insights page: trend charts, punch card grid (reuses
  the heatmap cell color levels), subagents table.
- `charts.css` — re-skins Frappe Charts' runtime-injected styles (axis
  labels, gridlines, tooltip) with the design tokens, and hides Frappe's
  built-in legend in favor of the cards' own HTML legends.

Deferred:

- A **sparkline** primitive sketched in
  [`../panel/components.md`](../panel/components.md). The cost-share,
  hour-of-day, trend, spend, and model-share cards now render via Frappe
  Charts (`internal/panel/charts` builds the `Spec`; `charts-init.js`
  draws it); a compact inline sparkline can land later as a small Frappe
  `line` chart without changing routes or proto.

### Markdown rendering

Assistant content is markdown on the wire (both Claude Code and Codex
emit it). `internal/panel/render/markdown.go` wraps
`github.com/yuin/goldmark` (GFM extension, hardwraps on, `WithUnsafe`
off) and exposes two helpers:

- `Markdown(s)` for assistant bodies — full markdown surface.
- `PlainText(s)` for user and tool bodies — HTML-escaped with
  `\n → <br>` so prompts and tool output keep their layout without
  enabling any markdown directives.

Goldmark either escapes or omits raw HTML blocks, so a literal
`<script>` in model output cannot reach the DOM as markup. The
dependency is justified because the alternative — rendering markdown
ourselves — would balloon to hundreds of lines for marginal value;
the assistant content *is* markdown and treating it as anything else
loses information.

## Auth

Two flows, both single-user.

### OAuth (production)

GitHub OAuth. The flow lives in `internal/panel/handlers/auth.go`
(approximately):

1. `GET /login` → render `login.html` with a `Continue with GitHub` button.
2. Button links to GitHub's `authorize` URL with `state` (random + cookie),
   redirect URI = `PROSA_PANEL_PUBLIC_URL/oauth/github/callback`.
3. `GET /oauth/github/callback` validates `state`, exchanges `code` for an
   access token, fetches verified emails.
4. The first email matching `PROSA_OWNER_EMAILS` succeeds; anything else
   returns 403.
5. The handler sets an HMAC-signed session cookie (`HttpOnly`, `Secure`,
   `SameSite=Lax`, TTL 30 days) and redirects to `/`.

### Dev-login (development)

`PROSA_PANEL_DEV_LOGIN=<email>` exposes `POST /dev-login`. The handler
requires the login page CSRF token, issues a session for the given email
with no OAuth roundtrip, and prints a loud warning at boot. Do not enable
in production.

### Session cookie

`internal/panel/session/cookie.go` HMACs the cookie value with
`PROSA_PANEL_COOKIE_KEY`. Cookie attributes: `HttpOnly`, `Secure` when
`PROSA_PANEL_COOKIE_SECURE=true`, `SameSite=Lax`, 30-day Max-Age. The
signed payload also carries the CSRF token rendered into state-changing
POST forms (`/logout`, `/cli/authorize/approve`, and device actions).

## Talking to the server

`internal/panel/rpc/client.go` builds Connect clients for
`SessionsService`, `DevicesService`, `AuthService`, `AnalyticsService`,
`PreferencesService`. Each call sends `Authorization: Admin
<PROSA_ADMIN_TOKEN>` so the server treats the panel as the owner.

`PreferencesService` stores panel UI preferences in the
`panel_preferences` Postgres table, keyed by owner email. Stored keys
cover the chosen theme, the default time window, and each page's saved
time window. The panel resolves the owner's theme on every full-page
render — cached in-process, invalidated on write — and stamps it onto
`<html data-theme>` server-side, so the first paint is correct with no
flash. Window filters resolve from `?last=`, then the page preference,
then the Settings default, then `30d`; valid `?last=` values are saved
for that page.

Settings POSTs to `/settings/theme`, `/settings/window`, and
`/settings/reset`. The reset deletes the stored panel preference keys,
so the rendered defaults are `almanac` and `30d`.

The `/events` route is a proxy: the panel opens an SSE stream to the
server's `/sse/events` and re-emits the bytes to the browser. This
preserves origin (browser → panel only) and gives the panel a chance to
filter what it forwards.

## HTMX patterns in use

- **Sidepanel session detail**: each row in the `/sessions` table has
  `hx-get` → `/sessions/<id>`, `hx-target` → `#side-panel`, `hx-swap` →
  `innerHTML`, `hx-push-url` → updates the query string with
  `?session=<id>`. The side panel opens in place; a refresh preserves
  it. Row clicks originate from the Sessions list.
- **Raw transcript pagination**: a `Load more` link near the end of
  `raw_chunk.html` has `hx-get` → `/raw/<id>?offset=N`, `hx-swap` →
  `beforeend`. Each chunk is at most 64 KB.
- **Subagents drill-down**: when the open session has children, each
  child card in the side panel HTMX-swaps the panel to the child
  session, preserving the URL via `hx-push-url`.

## Why this stack

In short: it stays cheap to run, cheap to ship, and cheap to debug.

- No build step → `go build` produces a single binary.
- No SPA framework → no client-side router, no client-side store, no
  hydration weirdness.
- HTMX for the 10% of pages that need partial updates → the panel feels
  alive without being heavy.
- Alpine.js for the UI states that don't need a server roundtrip
  (modal open/close, dropdown toggle) → 44 KB beats writing a vanilla
  toggle helper.

Anything bigger than this would need to clear the INTENT bar.
[`../../INTENT.md`](../../INTENT.md) describes the posture; the panel
design brief at [`../panel/design-brief.md`](../panel/design-brief.md)
applies that posture to the panel's visual direction.

## When changing the panel

- New template → add to `internal/panel/templates/` and update
  `server.loadViews()` if it's a top-level view.
- New route → add to the mux in `server.go`, decide whether it's gated.
- New env var → document in [`../self-hosting.md`](../self-hosting.md) and
  `internal/panel/config.go`.
- New static asset → drop into `internal/panel/assets/`. `embed.FS` picks
  it up on rebuild. New font files also need a corresponding `@font-face`
  in `css/fonts.css`.
- New visual component → first sketch in [`../panel/components.md`](../panel/components.md);
  then implement.
- New panel-level decision → consider invoking `prosa-panel-ui-reviewer`.
