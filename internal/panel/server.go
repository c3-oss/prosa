package panel

import (
	"context"
	"fmt"
	"html/template"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/c3-oss/prosa/internal/panel/assets"
	"github.com/c3-oss/prosa/internal/panel/rpc"
	"github.com/c3-oss/prosa/internal/panel/session"
	"github.com/c3-oss/prosa/internal/panel/templates"
	"github.com/c3-oss/prosa/pkg/httpserver"
)

// Panel is the assembled HTTP server. Build via New, drive with Serve.
type Panel struct {
	cfg     Config
	mux     *http.ServeMux
	views   map[string]*template.Template
	cookie  *session.Manager
	clients *rpc.Clients
}

// New parses the embedded templates and wires every route. Each view
// is parsed into its own template set together with base.html so that
// `{{define "content"}}` blocks don't collide between views.
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

// loadViews reads every *.html from the embedded FS and builds one
// template tree per top-level view, each combining base.html with the
// view's own definitions. Standalone helpers (side_panel, raw_chunk,
// login) are parsed without base.html.
func loadViews() (map[string]*template.Template, error) {
	type viewSpec struct {
		name  string
		files []string
	}
	// Each view's file list includes everything its templates reference.
	// Layered views start with base.html; standalone helpers stand alone.
	specs := []viewSpec{
		{"home", []string{"base.html", "home.html"}},
		{"sessions", []string{"base.html", "sessions.html", "side_panel.html", "icons.html"}},
		{"projects", []string{"base.html", "projects.html", "icons.html"}},
		{"settings", []string{"base.html", "settings.html"}},
		{"devices", []string{"base.html", "devices.html"}},
		{"login", []string{"login.html"}},
		{"cli_authorize", []string{"cli_authorize.html"}},
		{"side_panel", []string{"side_panel.html", "icons.html"}},
		{"raw_chunk", []string{"raw_chunk.html"}},
	}
	out := make(map[string]*template.Template, len(specs))
	for _, sp := range specs {
		t := template.New("").Funcs(templateFuncs())
		parsed, err := t.ParseFS(templates.FS, sp.files...)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", sp.name, err)
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

// routes wires every endpoint.
func (p *Panel) routes() {
	// Static assets.
	sub, _ := fs.Sub(assets.FS, ".")
	p.mux.Handle("/assets/", http.StripPrefix("/assets/", http.FileServer(http.FS(sub))))

	// Health (public).
	p.mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})

	// Auth surfaces (public).
	p.mux.HandleFunc("/login", p.handleLogin)
	p.mux.HandleFunc("/oauth/github/callback", p.handleGitHubCallback)
	p.mux.HandleFunc("/logout", p.csrfProtected(p.handleLogout))
	if p.cfg.DevLoginEmail != "" {
		slog.Warn("dev-login enabled — DO NOT use in production",
			"email", p.cfg.DevLoginEmail)
		p.mux.HandleFunc("/dev-login", p.csrfProtected(p.handleDevLogin))
	}

	// CLI login approval (session required; redirects to /login?next= when anonymous).
	p.mux.HandleFunc("/cli/authorize", p.requireSession(p.handleCliAuthorize))
	p.mux.HandleFunc("/cli/authorize/approve", p.requireSession(p.csrfProtected(p.handleCliAuthorizeApprove)))

	// Gated app routes — each one wraps p.requireSession around its handler.
	// "/sessions" (exact) is the list page; "/sessions/" (subtree prefix)
	// dispatches to the side-panel detail handler — http.ServeMux resolves
	// the longer match first, so they coexist. Don't tighten one without
	// minding the other.
	p.mux.HandleFunc("/", p.requireSession(p.handleHome))
	p.mux.HandleFunc("/sessions", p.requireSession(p.handleSessions))
	p.mux.HandleFunc("/sessions/", p.requireSession(p.handleSessionDetail))
	p.mux.HandleFunc("/projects", p.requireSession(p.handleProjects))
	p.mux.HandleFunc("/settings", p.requireSession(p.handleSettings))
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

// render shells out a template by name into w. Wraps the
// error-rendering boilerplate so handlers stay short. Each view has
// its own template tree so block redefinitions ("content", "search",
// "side") in sibling views don't shadow each other.
func (p *Panel) render(w http.ResponseWriter, name string, data any) {
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
