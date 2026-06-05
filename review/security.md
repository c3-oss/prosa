# Review: Security & Adversarial Analysis

> Date: 2026-06-05
> Branch: master @ 114f89a
> Scope: Adversarial review of input handling, auth, secrets, file ops, template safety, RPC handlers

## Threat model assumed

- The CLI user is trusted. The local machine is single-user (or at least not actively hostile).
- The server is owned by the user (Caian) and reached over TLS terminated by a reverse proxy; the Go process speaks plain h2c.
- Untrusted inputs come from: (1) malicious transcript files planted in `~/.claude/`, `~/.codex/`, `~/.cursor/`, `~/.gemini/`, `~/.hermes/`; (2) the OAuth callback flow; (3) any data ever sent to the panel; (4) any Connect request hitting prosa-server.
- The panel may be exposed to the public internet behind GitHub OAuth + owner-email whitelist; an attacker can probe its public surface even without credentials.
- A device bearer is trusted to push data for that device only — but the bearer itself is not high-privilege (single-user MVP, owner-token is separately scoped).

## Summary

Overall posture is reasonable for the MVP. SQL access is uniformly parameterized in both SQLite (`?`) and Postgres (`$N`) layers; FTS5 uses `MATCH ?` with positional binding so even malformed FTS5 grammar can't cross out of the query slot. The HMAC-signed session cookie, PKCE/loopback CLI login, owner-email whitelist, GitHub OAuth state cookie, and per-device scoping in handlers are wired correctly. `html/template` is used throughout the panel and the only `template.HTML` constructors (`Markdown`, `PlainText`, `agentBadge`, `projectLink`) all go through goldmark with unsafe HTML disabled or `template.HTMLEscapeString` first.

The biggest concrete risks I found:

1. **Path traversal in importer raw preservation** — every importer except hermes lets attacker-controlled session IDs (read out of the transcript file's JSON body / SQLite meta) drive `filepath.Join`, so a planted file with `"sessionId": "../../../foo"` writes outside the raw root and lets the attacker overwrite arbitrary user-owned files.
2. **Session ID format never validated on the server** — `Push` accepts any non-empty `sess.Id`; the same ID becomes the S3 object key (path-joined) and a SSE NOTIFY payload, so a malicious or compromised device bearer can write outside its key prefix and inject SSE events in the panel.
3. **Missing CSRF + missing security headers on the panel** — `/cli/authorize/approve`, `/devices/<id>/rename|revoke`, `/dev-login`, `/logout` are all POST routes guarded only by `SameSite=Lax`. There's no CSP, X-Frame-Options, X-Content-Type-Options. A logged-in browser visiting a malicious page can trip CLI-device approval via cross-site form POST.
4. **Owner-email whitelist isn't re-checked on every request** — once a cookie is issued, removing an email from `PROSA_OWNER_EMAILS` does nothing until the cookie expires (30 days).

What's defended well: SQL queries (no concatenation), PKCE+state validation in both CLI and panel OAuth flows, bearer hashing on the server (`HashBearer` → sha256), constant-time admin-token comparison, owner-vs-device authorization on every session/device handler, atomic write-tmp+rename for raw preservation, `template.HTML` usage paths.

## Findings

### Path traversal in importer `preserveRaw` — high

**Location:** `internal/importers/claudecode/raw.go:37`, `internal/importers/codex/raw.go:35`, `internal/importers/gemini/raw.go:35`, `internal/importers/cursor/raw.go:36`, `internal/importers/antigravity/raw.go:35`

Every importer reads a session ID out of the transcript body, then does:

```go
dst := filepath.Join(dir, sessionID+".jsonl")  // or .json / .db
tmp := dst + ".tmp"
out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
...
os.Rename(tmp, dst)
```

`sessionID` originates entirely from attacker-controlled content:

- Claude Code: first `sessionId` JSON field — `internal/importers/claudecode/parse.go:124` (`r.SessionID`).
- Codex: `session_meta.payload.id` — `internal/importers/codex/parse.go:171`.
- Gemini: `env.SessionID` from envelope or first array record — `internal/importers/gemini/parse.go:117,131`.
- Cursor: `meta.AgentID` from the store.db's hex-encoded JSON — `internal/importers/cursor/parse.go:77`.
- Antigravity: `cascade_id` from the trajectory_meta table — `internal/importers/antigravity/parse.go:98`.

There is no sanitization, no `filepath.Clean`, no `HasPrefix(root)` check, and no rune-class allowlist. A planted file under `~/.claude/projects/foo/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl` whose first record is `{"sessionId":"../../../../../home/cain/.ssh/authorized_keys","type":"user",...}` would cause `preserveRaw` to compute `dst = <PROSA_HOME>/raw/claude-code/2026/06/../../../../../home/cain/.ssh/authorized_keys.jsonl`, attempt to MkdirAll the (non-existent) parent (no-op since it exists), then write `.tmp` and `os.Rename` it on top of the user's authorized_keys file. Worst case: arbitrary file overwrite within the user's UID (a strong escalation primitive on a multi-user box).

**Even without an explicit `..` escape**, an attacker who controls the session ID controls the destination filename, which is then stored back into `sessions.raw_path` and uploaded to S3 by sync — see "Sync push trusts attacker-controlled raw_path" below.

Note also that the claude-code walker (`walk.go:16`) enforces UUID-shaped *filenames*, but the JSONL's interior `sessionId` field is not bound to the filename, and that's the value the raw destination uses.

**Suggested fix:** in each `preserveRaw`, validate `sessionID` against a strict pattern (UUID or `^[A-Za-z0-9._-]{1,128}$`) and reject anything that contains `/`, `\`, `..`, or is empty after `filepath.Clean`. Bonus: after computing `dst`, assert `filepath.Clean(dst)` still has `root` as a prefix.

### Push handler does not validate session.Id format — high

**Location:** `internal/server/handlers/sessions.go:48`, `:82`, and the SSE payload at `migrations/server/0004_session_notify.up.sql:9` + `internal/server/handlers/sse.go:92`

`Push` checks only `sess.Id != ""`. The same `sess.Id` is then:

- Joined into the S3 key — `path.Join(deviceID, agent, year, month, sessionID+ext)` at `rawKey` line 882. `path.Join` does NOT remove `..` segments; in S3 object storage, the key is a literal string and `..` won't traverse a real filesystem, but it does let a device with a valid bearer write under another device's key prefix (e.g., a device with id `attacker` could craft `sess.Id = "../victim/codex/2026/06/abc.jsonl"` and put the object under `victim/codex/...`). Cross-device read is still gated by the metadata row's `device_id` (forced server-side at line 55), so the attacker can't read it back via `GetRaw`, but they can pollute the victim's key space and run up storage costs.
- Stamped into Postgres `sessions.id`, which fires `prosa_notify_session_changed()` → `pg_notify('prosa.session.changed', NEW.id::text)`. The SSE handler then writes `event: session.changed\ndata: <id>\n\n`. **A session ID containing `\n` lets the device break the SSE framing and inject arbitrary events** into the panel's browser, including spoofed `session.changed` for IDs that don't exist (cheap), but more importantly fake `event: ...` lines that the panel JS dispatches. If the panel ever does `eventSource.addEventListener('something', ...)` with a payload it then evaluates / DOM-inserts, this becomes a vector. Today the panel listens only for `session.changed` (visible in `assets/sse.js`), so impact is limited, but the wire confusion is real.
- Used as `s3://...` URI material, parsed by `parseS3URI` (`sessions_get_raw.go:117`). A `/` in the ID would split incorrectly.

**Suggested fix:** in `Push`, validate `sess.Id` against `^[A-Za-z0-9._-]{1,128}$` (or UUID exactly) before any other work. Reject newlines, slashes, and `..` explicitly. Same goes for `sess.Agent` (used in `rawKey`) which is currently free-form despite `extForAgent` switching on it.

### Sync push trusts attacker-controlled raw_path verbatim — high

**Location:** `internal/cli/sync_push.go:89`

```go
raw, err := os.ReadFile(sess.RawPath)
```

`sess.RawPath` comes from the local SQLite store, which was populated by the importer using the same attacker-controlled session ID. If the path-traversal finding above succeeds in writing outside the raw root, the *next* sync push will dutifully read whatever file the attacker pointed to and upload it to S3 — turning the local file-write primitive into a remote exfiltration (e.g., bait the user into running `prosa sync`, then any file the attacker pre-staged the `raw_path` to point at gets pushed to the user's own S3 bucket, but if the attacker also has any other way to read S3 — wrong, S3 is private — they don't. The leak vector is then exposure to the panel; the panel renders the first 64 KiB through `loadSidePanel` after stripping binary chunks, and the user might paste / share that panel view).

The chained impact is mostly "local file → uploaded to user's own bucket → rendered in user's own panel". Limited unless the panel is shared, but the data trust line is still crossed.

**Suggested fix:** Before reading `sess.RawPath`, assert it lives under `paths.RawRoot(<agent>)` (use `filepath.EvalSymlinks` + `strings.HasPrefix(rawRoot)` after `filepath.Clean`). Refuse otherwise and surface a loud error.

### `/cli/authorize/approve` lacks CSRF protection — high

**Location:** `internal/panel/handlers_cli_auth.go:53`

The route accepts a same-origin POST with a `request_id` form field. The only guard is the cookie's `SameSite=Lax` attribute, which DOES block cross-site POSTs in modern browsers — but `SameSite=Lax` was famously not enforced uniformly until Chrome 80, allows top-level POST navigations (e.g., a form submitted via `target="_top"` after a user click), and isn't a substitute for a proper CSRF token. An attacker who tricks the user into visiting a malicious page can submit `<form method=post action="https://panel/cli/authorize/approve"><input name=request_id value=...></form><script>document.forms[0].submit()</script>`, and if the attacker also controls a CLI Begin call to mint the matching `request_id`, the panel will approve a device that the user never intended to authorize. Because device tokens currently grant full push + read of the device's own data, the attacker would end up with a valid bearer.

Same shape applies to `/dev-login` (`handlers_auth.go:115`), `/devices/<id>/rename`, `/devices/<id>/revoke` (`handlers_views.go:752`), `/logout` (`handlers_auth.go:135`).

**Suggested fix:** add a CSRF token. Cheapest correct approach: store a random 32-byte token in the panel session cookie payload at issue time (`session/cookie.go:Issue`); add a hidden `<input name="csrf">` to every POST form; check `r.FormValue("csrf")` against the cookie value in a constant-time compare on every state-changing handler. Also tighten the OAuth state cookie to `SameSite=Strict`.

### Missing security headers on every panel response — medium

**Location:** `internal/panel/server.go:163` (`render`) and every direct `w.Header().Set` in the panel

The panel never sets `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, or `Strict-Transport-Security`. Side effects:

- No CSP means any future template error that injects an unescaped tag (or a `template.HTML` regression) becomes a full XSS.
- No `X-Frame-Options` / `frame-ancestors` means the panel can be embedded in an iframe by any origin, enabling clickjacking against the device-rename/revoke and CLI-approval forms.
- No `nosniff` means HTMX swap targets might be MIME-confused.
- No HSTS means the public deployment depends entirely on the reverse proxy to set it.

**Suggested fix:** add a middleware that sets, for every panel response:

```
Content-Security-Policy: default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: same-origin
Strict-Transport-Security: max-age=63072000; includeSubDomains  (only when CookieSecure is true)
```

Audit `unsafe-inline` against the templates — looks like a few `style="..."` attributes are inline (e.g., `side_panel.html:19`, `cli_authorize.html:18`); either drop them or accept `style-src 'self' 'unsafe-inline'`.

### Owner-email whitelist isn't re-checked on every request — medium

**Location:** `internal/panel/session/cookie.go:91` (`FromRequest`)

`Manager.FromRequest` verifies the HMAC + expiry but does NOT re-check that the embedded email is still in `Config.OwnerEmails`. If an owner-email is removed from `PROSA_OWNER_EMAILS` (e.g., after a compromise of that GitHub account), the existing cookie remains valid until `DefaultTTL = 30 * 24h` elapses. There's no cookie revocation list and no way to force-logout an attacker who already has a session.

**Suggested fix:** in `requireSession` (`internal/panel/server.go:139`), after `p.cookie.FromRequest(r)` succeeds, call `p.cfg.IsOwnerEmail(s.Email)` and 302 to `/login` when false. Also reduce `DefaultTTL` to something like 7 days for an MVP that doesn't have refresh tokens.

### Dev-login bypasses OAuth with a fixed email — medium

**Location:** `internal/panel/handlers_auth.go:115`, `config.go:91`

When `PROSA_PANEL_DEV_LOGIN=hi@caian.org` is set, POST `/dev-login` issues a session cookie without any authentication. The route is mounted unconditionally when the env var is set and the log message is `slog.Warn("dev-login enabled — DO NOT use in production", ...)`. If a production deployment accidentally has `PROSA_PANEL_DEV_LOGIN` set (env-var leakage, copy-paste from dev), anyone on the internet can POST to `/dev-login` and get an owner session.

Combined with the missing CSRF token, a malicious link auto-submits the form on the user's browser even when the user is on a coffee-shop network and the panel is exposed.

**Suggested fix:** in `Load()` (`config.go:96`), refuse to start with both `DevLoginEmail != ""` and `CookieSecure == true` (cookies-secure usually correlates with production). Alternatively, bind dev-login only to `127.0.0.1` by checking `RemoteAddr` in the handler. At minimum, make the login button require typing the email manually (proof of user intent) and rate-limit the route.

### Server has no body size limit on Push uploads — medium

**Location:** `internal/server/server.go:71` (`Serve`) and `internal/server/handlers/sessions.go:39` (`Push`)

No `http.MaxBytesReader`, no `ReadHeaderTimeout`, no `ReadTimeout`, no `WriteTimeout`, no `IdleTimeout`. A malicious or buggy CLI can send a `PushRequest` with a multi-GB `raw` field and the server happily decodes the protobuf, runs `bytes.NewReader(req.Msg.Raw)`, and pushes the whole thing to S3. This is a denial-of-service vector (memory exhaustion: `req.Msg.Raw` is `[]byte`, fully buffered) and a storage-cost vector. Connect's default decode limit is configurable via `connect.WithReadMaxBytes`; it isn't set.

`ReadHeaderTimeout` absent also makes the server vulnerable to Slowloris-style attacks if a malicious peer can reach the h2c port directly (mitigated by the reverse proxy in production, but the threat model says the dev/local deployment is exposed too).

**Suggested fix:** in `New`, add `connect.WithReadMaxBytes(64 * 1024 * 1024)` (64 MiB — generous for legit transcripts) to every handler registration. Set `srv.ReadHeaderTimeout = 10*time.Second` and `srv.IdleTimeout = 120*time.Second` in `Serve`.

### Sessions list pagination is bounded but FTS query isn't — low

**Location:** `internal/server/handlers/sessions.go:207-214` and `:467`

`List` clamps `limit` to `[1, 1000]` with default 200, and `Search` clamps to `[1, 200]` with default 20 — good. Offset is clamped to ≥0. But `req.Msg.Query` for `List` and `Search` is passed straight to `plainto_tsquery('simple', $N)` without length cap. `plainto_tsquery` is OK with arbitrary text (it tokenizes safely), but a megabyte-long query string is still parsed and matched. Low risk.

**Suggested fix:** cap `req.Msg.Query` length at e.g. 1024 chars before passing to Postgres.

### SSE proxy forwards a 4096-byte buffer indefinitely with no timeout — low

**Location:** `internal/panel/handlers_views.go:828`

The panel's `/events` route opens a long-lived stream to the server's `/sse/events`, attaches the admin token, and pumps bytes back to the browser. There's no per-request timeout and no max bytes; a misbehaving upstream (or an attacker who somehow controls the prosa-server's NOTIFY payload — see the earlier finding about session.Id in NOTIFY) could keep the panel-side goroutine alive forever.

The panel's `Authorization: Admin <token>` is set from the panel's own config, so the admin token isn't leaked to the browser — but the panel acts as an authenticated relay. Defense-in-depth: if the upstream returns an unexpected payload, the panel mirrors it verbatim.

**Suggested fix:** set `req.Header.Set("Cache-Control", "no-cache")` + a connection deadline; also write a sanity filter that requires the SSE payload to match `^[a-zA-Z0-9-]{1,128}$` before mirroring.

### `gitleaks` allows hex-32 — low

**Location:** `.gitleaks.toml` (not read here; mentioned in the brief)

Not verified, but the typical patterns to manual-grep (`PROSA_ADMIN_TOKEN`, `PROSA_PANEL_COOKIE_KEY`, `PROSA_S3_SECRET_KEY`, `PROSA_PANEL_OAUTH_GH_SECRET`) all live in `.env` (gitignored) and `docker-compose.yml` (commit only refers to env var names, not values). I grepped for `password=`, `token=`, `secret=` in `internal/` and `cmd/` — no hardcoded values landed.

**Suggested fix:** none; this is hygiene-confirmation noise. Continue running `gitleaks` in CI.

### `extForAgent` falls back to `.bin` for unknown agents — nit

**Location:** `internal/server/handlers/sessions.go:885`

A device that pushes `sess.Agent = "; rm -rf /"` (or any string) will get its raw uploaded under `key = path.Join(deviceID, "; rm -rf /", year, month, sessionID+".bin")`. S3 won't care, but the agent string also becomes part of `sessions.agent` and ends up in the panel's `agentBadge` (escaped) and the analytics dropdown. The agent string isn't validated. Same finding as session.Id but lower impact.

**Suggested fix:** in `Push`, whitelist `sess.Agent` against the known set: `claude-code | codex | cursor | gemini | antigravity | hermes`.

### OAuth `redirect_uri` validation is loopback-only but allows any port — nit

**Location:** `internal/server/auth/login.go:271` (`validateLoopbackRedirect`)

The check rejects non-loopback hosts and non-`/callback` paths, which is correct for RFC 8252 (native app loopback). Port is unconstrained — that's intentional because OS-picked ephemeral ports vary. A malicious local process could squat on the loopback port between `BeginLogin` and the user clicking Approve, intercepting the auth code. Mitigation already in place: PKCE verifier check + one-shot code consumption + state binding. Low residual risk.

**Suggested fix:** none required for MVP. Long term, sign the bind address into the begin request and re-verify on exchange.

### `bearerToken` extraction is constant-time-equal but the prefix-check isn't — nit

**Location:** `internal/server/auth/middleware.go:108`

`schemeToken` uses `strings.EqualFold` on the scheme prefix, which is NOT constant-time. Negligible — the scheme is `bearer` or `admin`, both publicly known. The actual token compare uses `subtle.ConstantTimeCompare` (`middleware.go:93`). No fix needed.

### Logging includes email, request_id, fingerprint — nit

**Location:** `internal/panel/handlers_auth.go:100`, `:109`, `internal/panel/handlers_cli_auth.go:28`, `:70`, `:86`

`slog.Warn("login denied — email not in whitelist", "email", email)` logs the rejected email in plaintext. Acceptable for a single-user system the user owns, but on a shared box the log file might be readable by other users. Same for the device fingerprint and request ID. **No tokens, no cookie values, no PKCE verifiers are logged** — that's well-defended.

**Suggested fix:** keep as-is for MVP; consider masking the local-part of the email when CookieSecure (production) is true.

### Raw files written with 0644, prosa data dir is 0755 — nit

**Location:** `internal/importers/*/raw.go:44` (`0o644`), `internal/store/store.go:48` (`0o755`)

On a shared multi-user box, other local users can read `~/.local/share/prosa/raw/.../*.jsonl` and `~/.local/share/prosa/store.db`. The threat model says single-user, so this is acceptable, but worth flagging. The auth file is correctly `0600` (`rpc/client.go:65`).

**Suggested fix:** consider tightening to `0o600` files inside `0o700` directories when `PROSA_HOME` is the default `~/.local/share/prosa`. Low priority.

### `parentSessionIDFromPath` trusts the filesystem layout — nit

**Location:** `internal/importers/claudecode/parse.go:278`, `walk.go:77`

Subagent parent IDs are derived from the directory layout (`<parent-uuid>/subagents/agent-<uuid>.jsonl`). A planted file could fake a parent ID by placing the subagent JSONL under any directory whose name matches `uuidLikeRE`. Worst case: a malicious file references a parent session that doesn't exist, the panel shows it under a session it doesn't belong to. Harmless data-poisoning for the threat model.

**Suggested fix:** validate the parent ID exists in the local store before stamping `sess.ParentSessionID`; or accept the data-poisoning since it's local-only.

### `gitRemoteLink` host check doesn't validate that the URL belongs to github/gitlab proper — nit

**Location:** `internal/panel/git_remote.go:39`

`gitRemoteLink` matches `host == "github.com"` and `host == "gitlab.com"` exactly — that's correct. Owner/repo are taken from path segments, then hardcoded into `https://github.com/%s/%s`. Since `fmt.Sprintf` with the hardcoded host means the URL host can't be tampered with, and the eventual `template.HTMLEscapeString` escapes any quotes from owner/repo, the resulting attribute is safe. The risk is only the visible label including HTML-meaningful chars — but they're escaped. No fix needed.

### `internal/panel/handlers_views.go:797` (`handleSSE`) — auth token in panel→server header — nit

**Location:** `internal/panel/handlers_views.go:806`

`req.Header.Set("Authorization", "Admin "+p.cfg.AdminToken)` adds the admin token to the panel→server SSE request. The admin token does not leave the panel process. Good.

### `validUTF8Sniff` and `isBinaryChunk` — nit

**Location:** `internal/panel/handlers_views.go:626-682`

Binary sniffing is conservative (NUL byte → binary, invalid UTF-8 → binary, SQLite magic → binary). The raw chunk is then HTML-escaped by `html/template` in `raw_chunk.html`. No risk surfaced. The placeholder text is fixed. Good.

### Connect handlers don't check Origin / disable CORS — low

Connect uses `application/json` or `application/proto` content types; modern browsers will send a preflight for the latter. Since the prosa-server doesn't set `Access-Control-Allow-Origin`, browsers will refuse cross-origin requests by default. The panel talks to the server server-side (via `clients.Sessions.List(...)`), not from the browser, so there's no client-side cross-origin call. **Confirmed by grep**: no `Access-Control-Allow-Origin` in any source file (only one comment in `handlers_views.go:798`).

A future feature that exposes Connect directly to a browser tab would need to add Origin validation; today this is fine.

**Suggested fix:** none required; verify with a quick `curl -H 'Origin: http://evil.com' http://localhost:7070/prosa.v1.SessionsService/List` to confirm pre-flight is rejected when you turn TLS on.

### CLI loopback callback handler is reachable by other local processes during login — low

**Location:** `internal/cli/login.go:36` (`net.Listen("tcp", "127.0.0.1:0")`)

During the ~15-minute login window, any local process on the same machine can race to `127.0.0.1:<port>/callback?code=...&state=...` and try to inject a code. The `state != clientState` check (`login.go:64`) defends against arbitrary attackers — they'd need to guess a 32-byte random hex string. Negligible.

### Cookie key fallback to raw bytes when not hex — nit

**Location:** `internal/panel/session/cookie.go:43`

```go
key, err := decodeHex(hexKey)
if err != nil {
    key = []byte(hexKey)
}
```

If `PROSA_PANEL_COOKIE_KEY` is set to something non-hex (a typo, a shell glob), the manager silently falls back to using the raw bytes. The HMAC still works but the entropy is whatever the string contains. Risk: a user who sets `PROSA_PANEL_COOKIE_KEY=changeme` gets a 7-byte HMAC key.

**Suggested fix:** in `Load()` (`config.go:84`), validate that the cookie key is exactly 64 hex chars and reject otherwise. Or warn loudly when fallback happens.

### Postgres `?` placeholder leak in pgx not applicable — nit

Looked for `$1`, `$2`, etc. across all queries. All Postgres queries use `$N` placeholders consistently. SQLite queries use `?` consistently. No string-concatenated SQL anywhere I checked except the analytics `errorTriggers` const, which is a hardcoded literal (`store/analytics.go:221`) and inert.

### Dependencies — low (needs verification)

`go.mod` shows current versions of `connectrpc.com/connect@v1.20.0`, `github.com/jackc/pgx/v5@v5.9.2`, `github.com/minio/minio-go/v7@v7.2.0`, `github.com/yuin/goldmark@v1.8.2`, `modernc.org/sqlite@v1.51.0`, `golang.org/x/crypto@v0.51.0`, `golang.org/x/net@v0.55.0`. None are obviously stale; pgx and minio-go are recent. `govulncheck` is not installed in the repo's `bin/`. **Needs verification:** run `go install golang.org/x/vuln/cmd/govulncheck@latest && govulncheck ./...` to confirm there are no known CVEs in the resolved dep tree.

---

## Quick wins (high ROI, low complexity)

1. **Add `validateSessionID(id)` and `validateAgent(a)` helpers**; call from both server `Push` and each importer's `preserveRaw`. Closes findings 1–3 in one stroke.
2. **Add a 5-line CSRF middleware** for the panel. Closes finding 4 plus its variants for `/dev-login`, `/devices/*`, `/logout`.
3. **Add security-headers middleware**. Closes finding 5.
4. **Re-check email whitelist in `requireSession`**. Closes finding 6.
5. **Set `connect.WithReadMaxBytes(64 << 20)` and `ReadHeaderTimeout`**. Closes finding 8.

These five changes would meaningfully harden the MVP without straying from INTENT.md's "lean > complete" posture — they're all small, local, and don't introduce new dependencies.
