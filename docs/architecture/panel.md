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
  pagination, future chart filters).
- **Alpine.js** (planned, ~15 KB) for client-only UI state (modal toggles,
  filter pill open/close, command palette).
- **SVG charts generated server-side in Go** (planned). Zero JavaScript
  charting library.
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
   ├─ internal/panel/templates/         HTML, CSS, JS via embed.FS
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
- `GET /logout`
- `POST /dev-login` (only when `PROSA_PANEL_DEV_LOGIN` is set)
- `GET /assets/*` — embedded static assets

**Gated by session cookie:**
- `GET /` — home timeline
- `GET /sessions/<id>` — session detail (HTMX partial)
- `GET /raw/<id>?offset=N` — raw transcript chunk (HTMX append-mode)
- `GET /devices` — device admin
- `POST /devices/<id>/rename`
- `POST /devices/<id>/revoke`
- `POST /devices/approve`
- `GET /analytics/<report>` — one of `sessions`, `tools`, `models`,
  `projects`, `errors`
- `GET /events` — SSE stream (proxied from the server)

Each handler:

1. Validates the session cookie (when gated).
2. Talks to the server via Connect.
3. Renders one of the pre-parsed templates.
4. Writes the result to `http.ResponseWriter`.

## Templates

`internal/panel/templates/` contains HTML files plus the `assets/`
subtree. Everything is embedded:

```go
//go:embed *.html assets
var FS embed.FS
```

At startup, `server.loadViews()` parses each view as its own template tree
bundled with `base.html` to avoid block collisions across siblings. The
result is a map: `viewName → *template.Template`. Handlers execute the
template by name.

Current template files (likely set; check the directory for ground truth):

- `base.html` — topbar, sidebar, main area, side panel slot.
- `home.html` — timeline + filters.
- `analytics.html` — table-form report (with charts coming).
- `devices.html` — device table + approval form.
- `side_panel.html` — HTMX fragment for session detail.
- `raw_chunk.html` — HTMX fragment for raw transcript pages.
- `login.html` — OAuth + dev-login.

Helper template funcs: minimal — `hasPrefix` for active-nav matching.

## Static assets

In `internal/panel/templates/assets/`:

- `htmx.min.js` (~50 KB) — vendored HTMX.
- `style.css` — handcrafted CSS, dark theme, CSS custom properties.
- `keyboard.js` — small keyboard handlers (`/`, `j/k`, `Esc`).
- `sse.js` — listens on `/events`, updates the "new sessions" badge.

Planned additions per the panel design brief:

- `alpine.min.js` (~15 KB) — for client-side UI state.
- `css/{tokens,base,layout,components}.css` — CSS split into modules,
  imported via native `@import` (no build step).
- New SVG charting package in Go (`internal/panel/charts/`) producing
  `template.HTML` for inline SVG.

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
issues a session for the given email with no OAuth roundtrip and prints a
loud warning at boot. Do not enable in production.

### Session cookie

`internal/panel/session/cookie.go` HMACs the cookie value with
`PROSA_PANEL_COOKIE_KEY`. Cookie attributes: `HttpOnly`, `Secure` when
`PROSA_PANEL_COOKIE_SECURE=true`, `SameSite=Lax`, 30-day Max-Age.

## Talking to the server

`internal/panel/rpc/client.go` builds Connect clients for
`SessionsService`, `DevicesService`, `AuthService`, `AnalyticsService`.
Each call sends `Authorization: Admin <PROSA_ADMIN_TOKEN>` so the server
treats the panel as the owner.

The `/events` route is a proxy: the panel opens an SSE stream to the
server's `/sse/events` and re-emits the bytes to the browser. This
preserves origin (browser → panel only) and gives the panel a chance to
filter what it forwards.

## HTMX patterns in use

- **Sidepanel session detail**: a row in the timeline has `hx-get` →
  `/sessions/<id>`, `hx-target` → `#side-panel`, `hx-swap` → `innerHTML`,
  `hx-push-url` → updates the query string with `?session=<id>`. Refresh
  preserves the open panel.
- **Raw transcript pagination**: a `Load more` link near the end of
  `raw_chunk.html` has `hx-get` → `/raw/<id>?offset=N`, `hx-swap` →
  `beforeend`. Each chunk is at most 64 KB.
- **Planned**: filter pills with Alpine state and `hx-trigger` events that
  swap charts on the analytics page.

## Why this stack

In short: it stays cheap to run, cheap to ship, and cheap to debug.

- No build step → `go build` produces a single binary.
- No SPA framework → no client-side router, no client-side store, no
  hydration weirdness.
- HTMX for the 10% of pages that need partial updates → the panel feels
  alive without being heavy.
- Alpine planned for the few UI states that don't need a server roundtrip
  (modal open/close, dropdown toggle) → 15 KB beats writing a vanilla
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
- New static asset → drop into `templates/assets/`. `embed.FS` picks it up
  on rebuild.
- New visual component → first sketch in [`../panel/components.md`](../panel/components.md);
  then implement.
- New panel-level decision → consider invoking `prosa-panel-ui-reviewer`.
