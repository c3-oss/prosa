# Review: Server & Panel

> Date: 2026-06-05
> Branch: master @ 114f89a
> Scope: prosa-server + prosa-panel — Connect handlers, OAuth, templates, HTMX, asset serving

## Architecture map

Two cleanly separated binaries, both rooted in `cmd/` thin entrypoints
that delegate to `internal/<binary>`.

**prosa-server** (`internal/server/`)

- `server.go` — assembles `http.ServeMux` with four Connect services
  (`AuthService`, `SessionsService`, `DevicesService`, `AnalyticsService`)
  registered through one shared `auth.Interceptor`, plus a public
  `HealthService`, plus a raw HTTP `/sse/events` endpoint (the only
  non-Connect path).
- `auth/login.go` — login state machine over the `auth_codes` Postgres
  table (PKCE PENDING → APPROVED → USED/EXPIRED).
- `auth/middleware.go` — Connect interceptor that resolves
  `Authorization: Bearer …` to `device_id` or `Authorization: Admin …`
  to an "owner" flag. Public RPCs (`Health.Check`, `Auth.BeginLogin`,
  `Auth.ExchangeCode`) bypass auth.
- `handlers/` — one file per service. Each handler embeds the generated
  `Unimplemented*ServiceHandler` so missing methods 501 instead of
  silently no-op. Direct `*pgxpool.Pool` + `*storage.ObjectStore` access
  from the handlers — there is no intermediate service layer.
- `storage/` — `OpenPG` (with migrations on boot) and `OpenS3`
  (with idempotent bucket creation) helpers.

**prosa-panel** (`internal/panel/`)

- `server.go` — same stdlib `net/http` + `http.ServeMux` shape.
  Auth gating is `requireSession` middleware around individual
  `HandleFunc` registrations (no nested mux).
- `oauth/github.go` — minimal stdlib-only GitHub OAuth web flow.
- `session/cookie.go` — HMAC-signed JSON session cookie, 30-day TTL.
- `handlers_*.go` — one file per route group (auth, sessions, projects,
  settings, cli_auth, views, devices live in handlers_views.go).
  `templates/*.html` are parsed once at boot through `embed.FS` into
  per-view template trees.
- `rpc/client.go` — bundled Connect clients with an `adminTransport`
  RoundTripper that stamps `Authorization: Admin <token>` on every call.
- `assets/` — vendored HTMX, Alpine, Alpine collapse plugin, the panel's
  CSS, plus three small vanilla JS shims (sse.js, keyboard.js, widgets.js).
- `render/` — markdown + duration + transcript grouping; consumed by the
  side-panel only.

**Dependency direction:** `panel → server` only. The panel never touches
Postgres or S3 directly. Both binaries use `pkg/httpserver.Run` for the
listener lifecycle.

**Migrations:** server-side migrations live in `migrations/server/`
embedded via `embed.FS` and applied in `OpenPG`. The panel applies no
migrations — it talks to the server's API and is otherwise stateless
(cookies aside).

## Summary

Posture overall is healthy and consistent with INTENT's "thin facade"
goal. The server stays small (5 Connect services, one SSE endpoint,
shared interceptor) and the panel keeps its HTML+HTMX shape without
SPA drift. The standout strengths are: a clean `auth.Service` separated
from the Connect handler shell, the same `withDevice/withOwner` pattern
applied uniformly across every read handler, the loopback-redirect
validation in `validateLoopbackRedirect`, constant-time admin token
comparison, and the panel's `safeNextPath` open-redirect guard.

**Weakest area:** `internal/server/handlers/sessions.go` is no longer
thin — at 1042 lines it is the file that has fattest. `Push`, `List`,
`Search`, and `Get` all assemble SQL inline; the FTS branch in `List`
shells out into a 70-line `if/else if` ladder; cross-cutting concerns
(device scoping, `since/until` checks, dynamic WHERE / placeholder
threading) repeat between `List`, `Search`, `ListChildren`,
`buildWhere`, and `GetRaw`. The handler is functionally correct but the
SQL-by-string-concatenation style now lives in three different shapes
across `handlers/sessions.go` and `handlers/analytics.go`. Either both
should adopt a small `squirrel`-style builder, or that logic should
move to an `internal/server/store/` package and leave handlers thin.

**Biggest divergence from "thin facade":** in the panel, not the
server. `internal/panel/handlers_views.go` is 1186 lines, packing
analytics-data shaping (`buildBarRows`, `buildUsage`, `buildHeatmap`,
`monthBands`), token-format helpers (`formatTokensCompact`,
`formatPanelInt`), binary detection (`isBinaryChunk`, `validUTF8Sniff`,
`utf8SequenceLen`), transcript turn projection (`buildDisplayTurns`,
`userExtrasFromParsed`), window math (`parseWindow`, `heatmapWindow`),
and three handlers (`handleHome`, `handleSessionDetail`,
`handleRawChunk`) plus the SSE proxy (`handleSSE`). It is the right
behavior, in the wrong file. A `panel/dashboard` (or `panel/views`
with multiple files) sub-package would do a lot of work here.

There is also one outright bug (medium) in the home dashboard's filter
narrowing (treats multi-select as "no narrowing"), one outright bug
(medium) in the side-panel HTMX close path (the `.sp-close` button
is rendered inside the swapped `<aside>` but the page-level keyboard
handler does the close — fine, but the row click handler can race
against the URL-state because two mechanisms write the URL), and a
small handful of low-severity inconsistencies in error handling.

## Findings

### Critical

None observed in scope. (The OAuth state cookie binds correctly to the
GitHub callback; the device-scoping enforcement is uniformly applied
to every read handler; the auth interceptor cannot be bypassed.)

### High

**[High] `handleSessions` uses the wrong agent / project narrowing for
multi-select** — `internal/panel/handlers_sessions.go:104-109`,
`internal/panel/handlers_views.go:77-82,91-96`.

When the user picks two or more agents (or two or more projects), the
handler sets the server-side `Agent` / `ProjectMatch` filter only when
`len(agents) == 1`. For `len > 1`, no narrowing is sent on the wire,
and `filterByAgents` / `filterByProjects` runs **only** on the rows
the server returned. The server already paginated those rows (50/page)
under unfiltered ordering. Result: a 2-agent multi-select against a
50-page corpus returns only the rows from the first page that match,
giving the user a deceptively short list. `total` and `pageCount`
remain the unfiltered totals so the pagination footer says "1 of 1
… 1247 sessions" while showing 8 rows.

Two fixes are reasonable: (a) widen the proto with a repeated
`agent`/`project_match` and push the filter to the server, or (b) keep
the wire as-is but fall back to the same "load all, filter, paginate"
path that `listSessionsSortedByCost` already implements (and apply it
both to multi-agent and to the cost sort case). (a) is the cleaner
choice given (b) means iterating all sessions in the window.

Same shape applies to `handleHome`'s `sharedReq`: the dashboard
silently widens to "all" when the multi-select carries more than one
value, with the in-code comment acknowledging the user-visible
inconsistency. That is a deliberate compromise on Home (KPIs stay
honest at the price of dashboard precision) — but the Sessions page
inherits the same proto narrowness, and there it produces a wrong
result rather than a coarser one.

**[High] `recover` on Connect handlers is delegated to net/http
defaults** — `internal/server/server.go:71-83`,
`internal/server/handlers/*.go` (all).

No middleware recovers from a panic in any handler. A nil deref or an
out-of-bounds in any of the `scan*` helpers in `sessions.go` would
take the goroutine through the default `net/http` panic handler, which
logs and closes the connection. With Connect, that means the caller
sees an `EOF` / `connection closed`, not a `connect.CodeInternal`
error — and the panic message is captured to the server's stdout
instead of the structured logger. Wrap the registered handlers in a
`connect.WithInterceptors(recoveryInterceptor)` so every panic becomes
`connect.CodeInternal` and lands in `slog`. Trivial to add (10-15
lines) and the absence of it is a real operational hazard given the
amount of dynamic SQL these handlers assemble.

**[High] `SSEHandler.authorized` short-circuits when
`AdminToken == ""`** — `internal/server/handlers/sse.go:107-123`.

The implementation looks correct, but is decoupled from the bearer
flow's `auth.Interceptor`. Two divergences worth flagging:

1. `SSEHandler` reads `r.Header.Get("Authorization")` raw and only
   handles the `Admin ` prefix. There is no path for a device bearer
   to subscribe (which is fine and matches docs/architecture/server.md)
   — but the **panel proxies** `/events` through to `/sse/events`
   stamping `Admin <token>`, so the browser session-cookie check is
   the only authn for the panel `/events` endpoint. Anyone with a
   panel session (i.e. anyone who passed `requireSession`) can attach
   to SSE — fine — but the panel SSE proxy uses
   `http.DefaultClient.Do(req)` (`handlers_views.go:809`) without a
   per-stream timeout, and the upstream stream is read in a 4-KiB
   loop with no `select { case <-r.Context().Done() }` short-circuit.
   When the browser disconnects, the goroutine relies on the upstream
   sending data (or EOF) for `resp.Body.Read` to return; in practice
   the heartbeat keeps this honest, but if the upstream stops
   responding the panel's goroutine leaks until the upstream times out.
2. `subtle.ConstantTimeCompare` on the case-folded prefix is overkill
   for a constant string — the data leak shape is the secret following
   it, and that is already constant-time compared. Cosmetic.

The "short-circuit when AdminToken empty" behavior in
`sse.go:119-122` correctly bails out, but the same defensive check is
missing in `auth.Service.IsAdminToken` (it returns false but does not
log). Low.

**[High] Side-panel HTMX swap and URL state can race when both the
row-click JS and the link-click HTMX target are armed on the same
row** — `internal/panel/templates/sessions.html:159,176-179`,
`internal/panel/assets/widgets.js:151-166`.

The session row carries `hx-push-url="{{.OpenURL}}"` (set on `<tr>`)
as well as a `data-href` attribute, and the inner `first_prompt` cell
has its own `<a hx-get hx-target hx-push-url>` link. `initRowOpen`
intercepts row-level clicks but stops at the link via
`ev.target.closest('a, button, ...')`. That guard is correct for
clicks on the inner anchor, but the row itself has `hx-push-url`
applied — HTMX will scan the `<tr>` for `hx-*` attributes too, even
though `hx-get` is not set on the row (so it stays as a click target
for the JS shim). The risk is HTMX scanning the row for any `hx-*`
attribute and noticing `hx-push-url` without a `hx-get`. In practice
this is benign (HTMX requires `hx-get` to fire) but the redundant
attribute on the `<tr>` is dead code and confuses the read.

Clean it up: drop `hx-push-url` from the `<tr>` (the JS shim does the
swap with explicit `htmx.ajax` and the link inside the cell handles
the rest).

### Medium

**[Medium] `handlers/sessions.go` is too fat** —
`internal/server/handlers/sessions.go:134-303,456-548`.

`List` alone is 170 lines of SQL string assembly with three separate
branches (FTS, total_tokens sort, project sort, device sort,
started_at default), four blocks of `idx++` placeholder threading,
and inline `GROUP BY` only in the FTS path. The same pattern repeats
in `Search` (without the sort dispatch but with a different `DISTINCT
ON`) and in `analytics.go`'s `buildWhere`. `_test.go` exists for sort
helpers, but the actual query construction is unit-test-free.

Concrete refactor:

1. Move the query-building helpers into
   `internal/server/store/sessions.go` (alongside the existing
   `internal/store/` for the local SQLite path).
2. Keep `handlers/sessions.go` to validation + auth-context plumbing +
   call into `store`. The current pattern of "device or owner else
   fail" is repeated 6 times verbatim in `sessions.go` alone and could
   be a one-line helper.
3. Adding a `WhereBuilder` with `b.Eq("agent", v)` /
   `b.In("device_friendly", names)` / `b.FTS("turn.content_tsv", q)`
   would collapse `addEq` + the duplicated multi-device branches across
   `List` / `Search` / `analytics.buildWhere`.

This is not a correctness issue; it is a maintenance one. If a sixth
filter shape lands, the cost of adding it stays linear-per-handler
rather than constant.

**[Medium] `handlers_views.go` is the analytics+side-panel+SSE+raw
chunk dumping ground** — `internal/panel/handlers_views.go` (whole
file).

This is the panel mirror of the sessions.go issue. Concrete split:

- `panel/dashboard/home.go` — `handleHome` + `buildBarRows` +
  `buildHeatmap` + `monthBands` + `buildUsage` + `usagePanelRow`.
- `panel/sidepanel.go` — `handleSessionDetail` + `handleRawChunk` +
  `loadSidePanel` + `sidePanelData` + `buildDisplayTurns` +
  `userExtrasFromParsed` + binary detection helpers.
- `panel/sse_proxy.go` — `handleSSE`.
- `panel/format.go` — `formatPanelInt`, `formatTokensCompact`,
  `formatCompactDecimal`, `parsePanelInt`.

Each split is mechanical (the handlers don't share private state).
The current bundling makes the file hard to scan and obscures which
helper belongs to which feature.

**[Medium] Per-view template tree duplicates template-name effort** —
`internal/panel/server.go:53-81`.

`loadViews` parses **each** view together with `base.html`,
`icons.html`, and (for sessions) `side_panel.html` — every layered
view re-parses `base.html` from scratch and the resulting trees are
isolated. This is a deliberate design choice (the comment explains the
block-collision concern) and works fine for nine views, but the cost
shape doesn't scale and there is no enforced single source of truth
for shared helpers (`agentBadge`, `projectLink`, `pluralize`,
`hasPrefix`, `projectDisplayLabel`). These live in `templateFuncs()`
and end up in **every** parsed tree — fine, but if one helper is
ever conditional ("only register if X"), it's not obvious where
that wiring lives.

Alternative: parse the whole tree once with `template.Must(template.
ParseFS(templates.FS, "*.html"))` and use the `template.New(name).
Clone()` + `ExecuteTemplate(w, "content")` pattern where blocks are
named per view (`home_content`, `sessions_content`, …). Less elegant
to read but eliminates the per-view ParseFS cost and the "did I add
icons.html to projects too?" footgun in `viewSpec`.

Low-medium because the current code works; flag for future scale.

**[Medium] Static assets have no `Cache-Control` or `ETag`** —
`internal/panel/server.go:99`.

`http.FileServer(http.FS(sub))` will emit `Last-Modified` headers
from the embed.FS modtime (which is always zero) and `Content-Length`,
but nothing else. HTMX and Alpine are 50 KiB + 44 KiB; on every
non-cached load the browser re-downloads them. For a single-user
panel this is irrelevant, but the recommendation is one line per
asset class: a thin wrapper that prepends `Cache-Control:
public, max-age=31536000, immutable` when the URL contains a hash
(otherwise `no-cache`). Since these assets ship inside the binary,
their content version equals the binary version; you could
incorporate `buildinfo.Version` into the asset URL (`/assets/v1/…`)
and serve `immutable`. Defer until the panel goes public.

**[Medium] `Cache-Control: no-cache` on SSE works, but `private` and
`X-Accel-Buffering: no` are inconsistent** —
`internal/server/handlers/sse.go:44-47`,
`internal/panel/handlers_views.go:821-824`.

The server's SSE handler sets `X-Accel-Buffering: no` so an nginx
front sidecar doesn't buffer the stream. The panel proxy copies the
same header but forwards it from the **upstream** without checking. If
the panel ever runs behind a different proxy, the upstream nginx
header may be dropped. Minor.

**[Medium] `handleSSE` proxy doesn't surface upstream cancellation** —
`internal/panel/handlers_views.go:809-843`.

`http.DefaultClient.Do(req)` is used. `http.DefaultClient` has no
timeout, which is **correct** for SSE — you don't want a 30s read
timeout killing the long stream — but the surrounding handler relies
on the upstream sending bytes (or closing) for `resp.Body.Read` to
return. On `r.Context().Done()` (client disconnect), the upstream
request context is cancelled (via `http.NewRequestWithContext`), but
the read loop will still spin until the upstream notices. This is
typically a couple of seconds; in pathological cases (upstream stuck)
the proxy goroutine leaks until the server's connection table reaps
it. The fix is to wrap the read loop in a `for { select { case
<-r.Context().Done(): return; default: ... read with deadline ...
} }` — but that contradicts the "long-stream" model. A simpler
mitigation is to set a `Transport` with `ResponseHeaderTimeout` so
the initial HTTP response is bounded (the body stream stays
unbounded as desired). The current code is fine for the dev path;
flag for production deployment.

**[Medium] HTTP server has no timeouts** — `internal/server/server.go:76-80`,
`internal/panel/server.go:84-93`.

Both `http.Server` instances are constructed without `ReadTimeout`,
`WriteTimeout`, `IdleTimeout`, or `MaxHeaderBytes`. A misbehaving
client (deliberate or accidental) can hold a connection open
indefinitely. The SSE endpoint needs `WriteTimeout=0` (effectively),
but a `ReadHeaderTimeout` of ~10s is uniformly safe and would block
slowloris-class behavior. Add these to `pkg/httpserver/httpserver.go`
or to each `http.Server` literal at construction.

**[Medium] `handleCliAuthorizeApprove` accepts any client_state /
redirect_uri from the server** —
`internal/panel/handlers_cli_auth.go:76-87`.

The panel reads `msg.RedirectUri` from the `ApproveLogin` response
and `http.Redirect`s the browser there. The server's
`validateLoopbackRedirect` already ensured this is `http://127.0.0.1`
or `http://localhost` with path `/callback`, so this **is** safe under
the current code path — but the panel itself trusts the server response
without re-validating. If anyone ever loosens the server-side guard,
the panel becomes an open redirect. Defensive (low) fix: copy the
validation into the panel and refuse to redirect to anything other
than loopback. Same applies to `target.Host` — currently anything goes
once the prefix has been validated server-side.

The same concern applies to the inline `url.Parse` in
`handleCliAuthorizeApprove:77`: a malformed `redirect_uri` returns
`http.Error(w, "invalid redirect_uri from server", 500)` which is
correct, but the underlying parse failure does not get logged. Add a
`slog.Error` so an operator can diagnose.

**[Medium] No CSRF token on state-changing POSTs** —
`internal/panel/templates/devices.html:26,38`,
`internal/panel/handlers_views.go:752-793`,
`internal/panel/handlers_cli_auth.go:53-87`,
`internal/panel/handlers_auth.go:120-132`.

`/devices/<id>/rename`, `/devices/<id>/revoke`, `/cli/authorize/approve`,
`/dev-login`, and `/logout` are all POST endpoints that mutate state
yet have no CSRF token. The mitigation is `SameSite=Lax` on the session
cookie, which **does** stop cross-site form submissions in modern
browsers — but a same-site embed (an XSS payload in an Outline page
served from the same effective site, or a rogue link click that lands
the user on a same-origin attacker page) can still POST to these
endpoints. For a single-user panel behind an OAuth wall the risk is
small. Worth flagging for the security reviewer; if the panel ever
hosts multi-user content, this becomes a real issue.

The shape of the fix would be a `csrf_token` field in the session
payload and a hidden `<input type="hidden" name="csrf">` rendered into
each form, validated by a middleware. Keep `SameSite=Lax`.

### Low

**[Low] Inconsistent error envelope between handlers**.

- `BeginLogin` returns every internal error as `connect.CodeInvalidArgument`
  (`internal/server/handlers/auth.go:38`) — including
  database-insert failures from `s.Pool.Exec` which should be Internal.
- `ExchangeCode` returns `connect.CodePermissionDenied` for every
  failure (auth.go:54), including the case where `tx.Begin` fails.
- `ApproveLogin` similarly buckets every error as PermissionDenied
  (auth.go:90).

A small `func wrapAuthErr(err error) error` that classifies on the
sentinel (`pgx.ErrNoRows` → NotFound; `errors.Is(err,
ErrUnknownToken)` → Unauthenticated; default → Internal) would tighten
the contract.

**[Low] `validUTF8Sniff` returns `true` when the input ends mid-rune** —
`internal/panel/handlers_views.go:652-667`.

This is documented and intentional, but the code path that distinguishes
"incomplete trailing rune" from "actually invalid" uses
`if need == 0 || need <= len(head)` which is correct but counterintuitive
(`need == 0` means an invalid lead byte; `need <= len(head)` means we
have enough bytes and the decode still failed). A short rename
(`expected := utf8SequenceLen(head[0]); if expected == 0 || expected
<= len(head) { return false }`) and a comment that pairs with the test
case in `_test.go:47` would help. The detection is correct.

**[Low] Side-panel close button is rendered into a fragment that gets
swapped, then the close button's handler lives on a static document
listener** — `internal/panel/templates/side_panel.html:9-12`,
`internal/panel/assets/keyboard.js:64-74`.

The `.sp-close` element is part of the side-panel partial. The keyboard
shim adds one document-level `click` listener that calls
`closeSidePanel` when `event.target.closest('.sp-close')` matches.
This works because of event bubbling and because the listener is added
**once** at page load, but the design hides the binding (the button has
no inline handler so a reader of the template can't see where the
click goes). Adding `@click="document.body.dispatchEvent(...)"` or a
`data-action="close-side-panel"` attribute makes the intent legible.

**[Low] `loadSidePanel` makes three sequential RPCs** —
`internal/panel/handlers_views.go:456-516`.

`Get`, `GetRaw`, and `ListChildren` are run serially. On a healthy LAN
this is 30-90ms total; with cross-region latency it doubles. Trivial
fan-out with `errgroup` — but `ListChildren` is best-effort (its
failure does not block the response), so adding it to an errgroup
requires keeping the soft-fail semantics. Acceptable as-is; flag for
when latency matters.

**[Low] Heatmap rendering does work in Go that arguably belongs in
CSS** — `internal/panel/handlers_views.go:982-1031`.

`monthBands` walks the cells array twice (once to find first non-blank
day per column, once to drop labels under 2-column bands). The
collapsing logic and the `Span` field both target CSS grid
`grid-column: span N`. The same effect is achievable with a fixed
`grid-template-columns` plus per-cell `data-month` attributes and a
CSS rule that uses `:has`/`:first-of-class` to surface labels. Not a
priority; just a "this could be CSS" note.

**[Low] `agentBadge` builds raw HTML strings instead of returning a
struct that the template renders** — `internal/panel/server.go:205-215`.

`fmt.Sprintf` with `%s` substitution into a fixed HTML literal works
and is properly escaped (`template.HTMLEscapeString`), but the
established pattern in the codebase for richer renderings is to expose
a struct + a template helper (see `projectDisplay` /
`projectLink`). For one-line badges this is fine; for any future
agent-pill variants, the struct approach scales better.

**[Low] `pkg/httpserver` lacks `ReadHeaderTimeout`, leaving the bare
`http.Server` exposed to Slowloris** — `pkg/httpserver/httpserver.go:19-42`.

`Run` does not configure timeouts on the server it is handed; it only
manages lifecycle. That is fine — but since both callers pass an
`http.Server` without timeouts and `httpserver.Run` is the canonical
helper, this is the natural place to set defaults. A `WithDefaults`
helper (or a sibling `RunWithDefaults(ctx, addr, mux, ...)`) would
quietly fix the issue everywhere.

**[Low] `replaceTurns` does N+1 inserts in a loop** —
`internal/server/handlers/sessions.go:982-1002`.

For a long session this is fine because turns are small and the loop
is inside a single transaction; pgx batches the round-trips
implicitly. But `COPY FROM` would be a textbook improvement for the
"replace 1000+ turns" case (which the importer can absolutely hit).
Defer until profiling shows it.

**[Low] `OpenS3.ensureBucket` swallows minio "race during create"
codes** — `internal/server/storage/objstore.go:42-57`.

The two codes (`BucketAlreadyOwnedByYou`, `BucketAlreadyExists`) are
the right ones to treat as success, but neither `slog`s the fact.
A debug log would help diagnose a misconfigured endpoint.

**[Low] `migratePG` runs each migration in its own transaction, then
inserts into `schema_migrations` in the **same** transaction** —
`internal/server/storage/pg.go:74-93`.

Correct (atomic-or-nothing), but for non-DDL migrations Postgres can
do this; for DDL inside a `BEGIN/COMMIT` block, some constructs
(certain `CREATE INDEX CONCURRENTLY`) don't work. None of the
existing migrations use those, but flag as a thing to keep in mind
when adding one. No change needed today.

**[Low] `auth.adminToken` and `auth.bearerToken` are case-insensitive
on the scheme but `sse.authorized` insists on lowercase `admin `**
— `internal/server/handlers/sse.go:107-123` vs `internal/server/auth/middleware.go:104-123`.

This is fine — the SSE handler is internal to the panel-server link
and the panel always sends `Admin <token>` — but the divergence
should be documented or unified. The `toLower` helper in `sse.go:125`
is a one-off that duplicates `strings.EqualFold` behavior.

### Nit

**[Nit] `handlers/sessions.go:665-674`**: hand-rolled `joinAnd`
duplicates `strings.Join(parts, " AND ")`. Same in
`analytics.go:160`.

**[Nit] `internal/server/handlers/sessions.go:407-450,548-664`**:
`scanSessionRow`, `scanSessionListRow`, `scanSearchHit` are three
variants of nearly identical scan code. Pulling the `*string`-pointer
plumbing into a small helper would cut ~80 lines.

**[Nit] `panel/server.go:165-176`**: the `switch name` to decide the
root template name is brittle (string match against the view name).
A `viewSpec` struct field (`Root string`) carried through `loadViews`
would centralize the convention.

**[Nit] `panel/handlers_views.go:208`**: `clampRows` is named like
a generic helper but lives next to one handler; if it stays here,
inline it; if it moves, find a `panel/lists.go` or similar.

**[Nit] `panel/render/markdown.go:38-40`**: when `md.Convert` fails,
the fallback is `escapePreserveLines(s)` — but the test suite has no
coverage for the failure branch. Goldmark conversion rarely fails
on valid input, but the fallback is the wrong shape for the caller
(it returns the bare HTML-escaped input without the surrounding
`<p>` that a successful render would emit). Minor; would be visible
only if the input was so malformed that goldmark gave up.

**[Nit] `panel/oauth/github.go:46-83`**: form-encoding the
client_secret in the body is the canonical GitHub flow; consider
adding a 10s timeout on the `http.DefaultClient.Do` call (currently
none) so a hanging GitHub does not park the whole login goroutine.

**[Nit] Template `sessions.html:159` has both `data-href` and
`hx-push-url` on the `<tr>`**: as noted above, drop one.

**[Nit] Markdown commit in `panel/render/markdown.go`** is configured
with `extension.GFM` but `WithUnsafe` is intentionally absent.
Confirmed safe; add the explicit `WithUnsafe(false)` (which is the
default) as a docstring comment so a future "let's enable raw HTML"
reader hesitates.

**[Nit] `panel/handlers_views.go:856-892`**: `analyticsRequest` is a
helper used only by `handleProjects`; if it stays, fine; if other
views adopt it, move it next to `pickDeviceNames`.

**[Nit] `panel/handlers_sessions.go:683-707`**: `listProjectLabels`
is a private method on `*Panel` that does one call. If you ever
need it from a non-`*Panel` caller, lift it to a package function
that takes the client.

**[Nit] `panel/templates/devices.html:38`**: the inline
`onsubmit="return confirm(...)"` works in 2025 but is the only
inline JS in the app. Replace with an Alpine `@submit.prevent` for
consistency, or move the confirm to widgets.js for parity with the
rename inline form.

## What I checked

- `cmd/prosa-server/main.go`, `cmd/prosa-panel/main.go` — boot
  sequence, ctx cancellation propagation, exit codes.
- `internal/server/server.go` — handler registration, interceptor
  wiring, health endpoint shape, server lifecycle.
- `internal/server/config.go` — env loading and required-field
  validation.
- `internal/server/auth/login.go` — PKCE flow correctness,
  loopback redirect validation, the FOR UPDATE in `Exchange` (good),
  the single-use guarantee under concurrency (covered by test
  `TestExchangeCodeSingleUseUnderConcurrency`).
- `internal/server/auth/middleware.go` — `Authorization: Admin`
  path, `Authorization: Bearer` path, public RPC bypass, constant-
  time comparisons.
- `internal/server/handlers/*.go` — all five: `auth.go`, `sessions.go`,
  `sessions_get_raw.go`, `devices.go`, `analytics.go`, `sse.go`,
  `common.go`. Owner vs device scoping uniformly applied; only
  `Manifest` is device-only (correct).
- `internal/server/storage/objstore.go`, `internal/server/storage/pg.go`
  — bucket create, migration application, version tracking.
- `pkg/httpserver/httpserver.go` — graceful shutdown plus force-close
  fallback. No timeouts.
- `internal/panel/server.go` — route table, requireSession middleware,
  template loading, asset serving.
- `internal/panel/handlers_*.go` — every handler in every file.
- `internal/panel/oauth/github.go` — state cookie, code exchange,
  verified email fetch.
- `internal/panel/session/cookie.go` — HMAC signing, key handling,
  expiry check.
- `internal/panel/rpc/client.go` — Connect client wiring, admin
  RoundTripper.
- `internal/panel/render/group.go`, `markdown.go`, `duration.go` —
  transcript grouping (good test coverage), markdown sandboxing
  (goldmark, WithUnsafe absent — safe).
- `internal/panel/templates/*.html` — every file: base, home,
  sessions, projects, devices, login, cli_authorize, settings,
  side_panel, raw_chunk, icons. Template func usage; HTMX attribute
  patterns; form posting and CSRF surface.
- `internal/panel/assets/*.js` — sse.js, keyboard.js, widgets.js
  (vendored htmx.min.js / alpine.min.js / alpine-collapse.min.js
  not reviewed).
- Cross-checked the CLI's `render/` package against the panel's
  `render/` package: they share neither code nor types. CLI
  emits terminal output (lipgloss-style styling); panel emits
  HTML (template-typed `template.HTML`). No duplication that hurts;
  one could imagine a shared `render/text` for cardinality/duration
  helpers but the current split is sound.
- Migrations: server has 9 migrations, all `0001_init` …
  `0009_auth_codes`. Panel has none. Confirmed the panel does not
  open Postgres directly and the server's migrate-on-boot is
  embed.FS-driven.

## Recommendations

In rough priority order:

1. **Fix the multi-select agent/project narrowing on `/sessions`**.
   Either widen the proto with repeated fields or fall back to the
   "load all, filter, paginate" path that cost sort already implements.
   This is the only finding I'd call a bug.

2. **Add a panic-recovery interceptor on the server**. Wrap every
   Connect handler so a programming error becomes
   `CodeInternal + slog.Error` instead of "EOF" on the wire.

3. **Set HTTP timeouts** in `pkg/httpserver` (at minimum
   `ReadHeaderTimeout` of 10s). Apply to both server and panel.

4. **Split `internal/server/handlers/sessions.go`** by moving the
   query builders into a `store` sub-package and keeping handlers
   thin. Doing this would naturally surface a `WhereBuilder` /
   `addEq` consolidation across `sessions.go` and `analytics.go`.

5. **Split `internal/panel/handlers_views.go`** into the four files
   listed under [Medium]. Mechanical; no behavior change.

6. **Static asset cache headers**. Wrap the file server in a
   `cacheImmutable` middleware once a versioned URL is in place.

7. **CSRF tokens on state-changing POSTs**. Cheap to add; matches
   what a security reviewer will flag.

8. **Document the SSE proxy timeout posture** and consider a
   `ResponseHeaderTimeout` for the panel→server SSE dial.

9. **Inconsistent Connect error codes** in the auth handler family.
   One short classifier function would tighten the contract.

10. **Bind template root names through `viewSpec`** rather than the
    switch in `render`, and merge the row-level `hx-push-url` /
    `data-href` redundancy in `sessions.html`.

Items 4 and 5 are the biggest single win on maintenance load; everything
else is small.
