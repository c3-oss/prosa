package panel

import (
	"context"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/c3-oss/prosa/internal/httpserver"
	"github.com/c3-oss/prosa/internal/panel/rpc"
	"github.com/c3-oss/prosa/internal/panel/session"
	"github.com/c3-oss/prosa/internal/panel/templates"
)

// Panel is the assembled HTTP server. Build via New, drive with Serve.
type Panel struct {
	cfg     Config
	mux     *http.ServeMux
	views   map[string]*template.Template
	cookie  *session.Manager
	clients *rpc.Clients

	// themeCache memoizes the per-owner theme so full-page renders don't
	// hit the server on every request; handleSetTheme invalidates it.
	themeMu    sync.RWMutex
	themeCache map[string]string
}

// New parses the embedded templates and wires every route. Each view gets
// its own clone so per-view `{{define "content"}}` / `{{define "side"}}`
// blocks don't collide, while shared templates are parsed once.
func New(cfg Config) (*Panel, error) {
	views, err := loadViews()
	if err != nil {
		return nil, fmt.Errorf("parse templates: %w", err)
	}
	p := &Panel{
		cfg:     cfg,
		mux:     http.NewServeMux(),
		views:   views,
		cookie:  session.NewManager(cfg.CookieKey, cfg.CookieSecure),
		clients: rpc.New(cfg.ServerURL, cfg.AdminToken),
	}
	p.routes()
	return p, nil
}

// loadViews builds one template tree per top-level view. Shared templates
// (base layout, icons, side-panel body) are parsed once, then cloned before
// each view-specific file is parsed into the clone. That keeps the current
// per-view content/side block isolation without requiring every view spec to
// remember which shared partials it indirectly references.
func loadViews() (map[string]*template.Template, error) {
	type viewSpec struct {
		name string
		file string
	}
	specs := []viewSpec{
		{"home", "home.html"},
		{"insights", "insights.html"},
		{"sessions", "sessions.html"},
		{"projects", "projects.html"},
		{"profiles", "profiles.html"},
		{"settings", "settings.html"},
		{"devices", "devices.html"},
		{"login", "login.html"},
		{"cli_authorize", "cli_authorize.html"},
		{"side_panel", ""},
		{"raw_chunk", "raw_chunk.html"},
	}
	shared, err := template.New("").Funcs(templateFuncs()).ParseFS(
		templates.FS,
		"base.html",
		"icons.html",
		"side_panel.html",
		"dashboard_filters.html",
	)
	if err != nil {
		return nil, fmt.Errorf("parse shared templates: %w", err)
	}
	out := make(map[string]*template.Template, len(specs))
	for _, sp := range specs {
		parsed, err := shared.Clone()
		if err != nil {
			return nil, fmt.Errorf("clone shared templates for %s: %w", sp.name, err)
		}
		if sp.file != "" {
			parsed, err = parsed.ParseFS(templates.FS, sp.file)
			if err != nil {
				return nil, fmt.Errorf("parse %s: %w", sp.name, err)
			}
		}
		out[sp.name] = parsed
	}
	return out, nil
}

// Serve binds the configured listener and blocks until ctx fires.
func (p *Panel) Serve(ctx context.Context) error {
	srv := &http.Server{
		Addr:    p.cfg.ListenAddr,
		Handler: p.securityHeaders(p.mux),
		// ReadHeaderTimeout blocks slowloris-style slow-header attacks.
		// No ReadTimeout/WriteTimeout: /events proxies a long-lived SSE
		// stream, so bounding the write side would cut it off.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	slog.Info("prosa-panel listening",
		"addr", p.cfg.ListenAddr, "server", p.cfg.ServerURL,
		"dev_login", p.cfg.DevLoginEmail != "")
	return httpserver.Run(ctx, srv, 5*time.Second)
}

func (p *Panel) routes() {
	assets, err := assetHandler()
	if err != nil {
		slog.Error("panel asset handler unavailable", "err", err)
		assets = http.NotFoundHandler()
	}
	p.mux.Handle("/assets/", assets)

	p.mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})

	p.mux.HandleFunc("/login", p.handleLogin)
	p.mux.HandleFunc("/oauth/github/callback", p.handleGitHubCallback)
	p.mux.HandleFunc("/logout", p.csrfProtected(p.handleLogout))
	if p.cfg.DevLoginEmail != "" {
		slog.Warn("dev-login enabled — DO NOT use in production",
			"email", p.cfg.DevLoginEmail)
		p.mux.HandleFunc("/dev-login", p.csrfProtected(p.handleDevLogin))
	}

	p.mux.HandleFunc("/cli/authorize", p.requireSession(p.handleCliAuthorize))
	p.mux.HandleFunc("/cli/authorize/approve", p.requireSession(p.csrfProtected(p.handleCliAuthorizeApprove)))

	// Gated app routes — each one wraps p.requireSession around its handler.
	// "/sessions" (exact) is the list page; "/sessions/" (subtree prefix)
	// dispatches to the side-panel detail handler — http.ServeMux resolves
	// the longer match first, so they coexist. Don't tighten one without
	// minding the other.
	p.mux.HandleFunc("/", p.requireSession(p.handleHome))
	p.mux.HandleFunc("/insights", p.requireSession(p.handleInsights))
	p.mux.HandleFunc("/sessions", p.requireSession(p.handleSessions))
	p.mux.HandleFunc("/sessions/", p.requireSession(p.handleSessionDetail))
	p.mux.HandleFunc("/projects", p.requireSession(p.handleProjects))
	p.mux.HandleFunc("/profiles", p.requireSession(p.handleProfiles))
	p.mux.HandleFunc("/settings", p.requireSession(p.handleSettings))
	p.mux.HandleFunc("/settings/theme", p.requireSession(p.csrfProtected(p.handleSetTheme)))
	p.mux.HandleFunc("/settings/window", p.requireSession(p.csrfProtected(p.handleSetDefaultWindow)))
	p.mux.HandleFunc("/settings/app-tokens", p.requireSession(p.csrfProtected(p.handleCreateAppToken)))
	p.mux.HandleFunc("/settings/app-tokens/revoke", p.requireSession(p.csrfProtected(p.handleRevokeAppToken)))
	p.mux.HandleFunc("/settings/reset", p.requireSession(p.csrfProtected(p.handleResetPreferences)))
	p.mux.HandleFunc("/raw/", p.requireSession(p.handleRawChunk))
	p.mux.HandleFunc("/devices", p.requireSession(p.handleDevices))
	p.mux.HandleFunc("/devices/", p.requireSession(p.csrfProtected(p.handleDevicesAction)))
	p.mux.HandleFunc("/events", p.requireSession(p.handleSSE))
}

// requireSession is the auth gate. Anonymous browsers get a 302 to
// /login; logged-in browsers proceed.
func (p *Panel) requireSession(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s, ok := p.cookie.FromRequest(r)
		if !ok {
			nextURL := r.URL.Path
			if r.URL.RawQuery != "" {
				nextURL += "?" + r.URL.RawQuery
			}
			http.Redirect(w, r, "/login?next="+url.QueryEscape(nextURL), http.StatusFound)
			return
		}
		// Re-check the owner whitelist on every request, not just at issue
		// time: removing an email from PROSA_OWNER_EMAILS is the documented
		// incident-response lever, and it must force-logout an existing
		// (HMAC-valid) cookie immediately rather than waiting out its TTL.
		if !p.cfg.IsOwnerEmail(s.Email) {
			slog.Warn("panel session rejected: email no longer whitelisted", "email", s.Email)
			p.cookie.Clear(w)
			http.Redirect(w, r, "/login", http.StatusFound)
			return
		}
		if s.CSRF == "" {
			if err := p.cookie.Issue(w, s.Email); err != nil {
				slog.Error("session csrf refresh failed", "err", err)
				http.Error(w, "internal panel error", http.StatusInternalServerError)
				return
			}
			nextURL := r.URL.Path
			if r.URL.RawQuery != "" {
				nextURL += "?" + r.URL.RawQuery
			}
			http.Redirect(w, r, nextURL, http.StatusFound)
			return
		}
		next(w, r)
	}
}

// render executes the named template into w. Each view has its own
// template tree so block redefinitions ("content", "search", "side")
// in sibling views don't shadow each other.
func (p *Panel) render(w http.ResponseWriter, r *http.Request, name string, data any) {
	t, ok := p.views[name]
	if !ok {
		slog.Error("template not found", "name", name)
		http.Error(w, "internal panel error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// Layered views render via "base"; standalone helpers render their
	// own top-level define directly.
	root := "base"
	switch name {
	case "login", "cli_authorize", "side_panel", "raw_chunk":
		root = name
	}
	// Full-page (base layout) renders resolve the owner's theme so
	// <html data-theme> is correct on first paint. Partial swaps and
	// pre-auth pages skip the lookup. A handler may preset "Theme".
	if root == "base" {
		if m, ok := data.(map[string]any); ok {
			if _, set := m["Theme"]; !set {
				m["Theme"] = p.currentTheme(r)
			}
		}
	}
	if err := t.ExecuteTemplate(w, root, data); err != nil {
		slog.Error("template render failed", "name", name, "err", err)
		http.Error(w, "internal panel error", http.StatusInternalServerError)
	}
}

// templateFuncs are the helpers exposed to every template.
func templateFuncs() template.FuncMap {
	return template.FuncMap{
		"hasPrefix":           strings.HasPrefix,
		"pluralize":           pluralize,
		"agentBadge":          agentBadge,
		"agentShortLabel":     agentShortLabel,
		"kindBadge":           kindBadge,
		"assetPath":           assetPath,
		"projectLink":         projectLink,
		"projectDisplayLabel": projectDisplayFromLabel,
	}
}

// pluralize returns "<n> <singular>" when n == 1 and "<n> <plural>" otherwise.
// Used by templates so user-facing strings stay grammatical for both the
// 1-session day in a 7d heatmap and the 200-session day in a 1y view.
func pluralize(n int64, singular, plural string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, singular)
	}
	return fmt.Sprintf("%d %s", n, plural)
}

// agentBadge renders an agent name as the small colored pill the
// templates use in tables, the sidepanel header, and dashboard cards.
// The data-agent attribute drives per-agent colors via agent-badge.css;
// the title attribute carries the full original name so a hover reveals
// it even when the visible label is shortened.
func agentBadge(agent string) template.HTML {
	a := template.HTMLEscapeString(strings.TrimSpace(agent))
	short := template.HTMLEscapeString(agentShortLabel(agent))
	if a == "" {
		return ""
	}
	return template.HTML(fmt.Sprintf(
		`<span class="agent-badge" data-agent="%s" title="%s">%s</span>`,
		a, a, short,
	))
}

// kindBadge renders a special-session classification as the small
// colored pill the Sessions table and side panel show. The data-kind
// attribute drives per-kind colors via kind-badge.css; the title carries
// a human description. Unknown kinds pass through with their raw label.
func kindBadge(kind string) template.HTML {
	k := template.HTMLEscapeString(strings.TrimSpace(kind))
	if k == "" {
		return ""
	}
	short := template.HTMLEscapeString(kindShortLabel(kind))
	return template.HTML(fmt.Sprintf(
		`<span class="kind-badge" data-kind="%s" title="%s session">%s</span>`,
		k, k, short,
	))
}

// kindShortLabel collapses a kind to the compact label shown in the
// table; the title attribute keeps the full kind on hover.
func kindShortLabel(kind string) string {
	switch strings.TrimSpace(kind) {
	case "goal":
		return "goal"
	case "workflow":
		return "workflow"
	case "ralph-loop":
		return "ralph"
	case "orchestrator":
		return "orch"
	default:
		return kind
	}
}

// agentShortLabel collapses the on-the-wire agent name to a compact
// visible label so the badge fits the table column. Unknown agents
// pass through unchanged.
func agentShortLabel(agent string) string {
	switch strings.TrimSpace(agent) {
	case "claude-code":
		return "claude"
	case "antigravity":
		return "antigrav"
	default:
		return agent
	}
}
