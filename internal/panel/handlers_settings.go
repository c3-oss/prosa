package panel

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
)

// handleSettings renders the owner settings page. The cookie is already
// validated by requireSession, so FromRequest should always succeed here.
func (p *Panel) handleSettings(w http.ResponseWriter, r *http.Request) {
	p.render(w, r, "settings", p.settingsData(r.Context(), r, "", ""))
}

func (p *Panel) settingsData(ctx context.Context, r *http.Request, newAppTokenSecret, appTokenError string) map[string]any {
	email := "unknown"
	if s, ok := p.cookie.FromRequest(r); ok {
		email = s.Email
	}
	theme := p.currentTheme(r)
	defaultWindow := p.currentDefaultWindow(r)
	appTokens, err := p.appTokens(ctx)
	if err != nil {
		slog.Error("app_tokens.list failed", "err", err)
		appTokenError = err.Error()
	}
	return map[string]any{
		"Title":         "Settings",
		"Nav":           "settings",
		"Email":         email,
		"CSRF":          p.csrfFromRequest(r),
		"Themes":        Themes,
		"Current":       theme,
		"Theme":         theme,
		"DefaultWindow": defaultWindow,
		"WindowOptions": windowOptions,
		"AppTokens":     appTokens,
		"NewAppToken":   newAppTokenSecret,
		"AppTokenError": appTokenError,
	}
}

// handleSetTheme persists the owner's theme choice via PreferencesService
// and refreshes the in-memory cache. The picker posts here on every
// change; a no-JS form submit falls back to a redirect.
func (p *Panel) handleSetTheme(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	theme := strings.TrimSpace(r.FormValue("theme"))
	if !validTheme(theme) {
		http.Error(w, "unknown theme", http.StatusBadRequest)
		return
	}
	s, ok := p.cookie.FromRequest(r)
	if !ok {
		http.Error(w, "no session", http.StatusUnauthorized)
		return
	}
	if err := p.setPreferenceValue(r.Context(), s.Email, themePrefKey, theme); err != nil {
		slog.Error("preferences.set failed", "email", s.Email, "err", err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	p.cacheTheme(s.Email, theme)
	if r.Header.Get("HX-Request") != "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	http.Redirect(w, r, "/settings", http.StatusSeeOther)
}

func (p *Panel) handleSetDefaultWindow(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	window := strings.TrimSpace(r.FormValue("window"))
	if !validWindow(window) {
		http.Error(w, "unknown window", http.StatusBadRequest)
		return
	}
	s, ok := p.cookie.FromRequest(r)
	if !ok {
		http.Error(w, "no session", http.StatusUnauthorized)
		return
	}
	var err error
	if window == defaultWindowValue {
		err = p.deletePreferenceValue(r.Context(), s.Email, windowDefaultKey)
	} else {
		err = p.setPreferenceValue(r.Context(), s.Email, windowDefaultKey, window)
	}
	if err != nil {
		slog.Error("preferences.window failed", "email", s.Email, "err", err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if r.Header.Get("HX-Request") != "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	http.Redirect(w, r, "/settings", http.StatusSeeOther)
}

func (p *Panel) handleCreateAppToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" {
		p.render(w, r, "settings", p.settingsData(r.Context(), r, "", "token name is required"))
		return
	}
	resp, err := p.clients.AppTokens.Create(r.Context(),
		connect.NewRequest(&prosav1.AppTokensServiceCreateRequest{Name: name}))
	if err != nil {
		p.render(w, r, "settings", p.settingsData(r.Context(), r, "", err.Error()))
		return
	}
	p.render(w, r, "settings", p.settingsData(r.Context(), r, resp.Msg.Secret, ""))
}

func (p *Panel) handleRevokeAppToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	id := strings.TrimSpace(r.FormValue("id"))
	if id == "" {
		http.Error(w, "missing token id", http.StatusBadRequest)
		return
	}
	if _, err := p.clients.AppTokens.Revoke(r.Context(),
		connect.NewRequest(&prosav1.AppTokensServiceRevokeRequest{Id: id})); err != nil {
		p.render(w, r, "settings", p.settingsData(r.Context(), r, "", err.Error()))
		return
	}
	http.Redirect(w, r, "/settings", http.StatusSeeOther)
}

func (p *Panel) handleResetPreferences(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s, ok := p.cookie.FromRequest(r)
	if !ok {
		http.Error(w, "no session", http.StatusUnauthorized)
		return
	}
	for _, key := range []string{
		themePrefKey,
		windowDefaultKey,
		windowPageKey(windowPageHome),
		windowPageKey(windowPageInsights),
		windowPageKey(windowPageSessions),
		windowPageKey(windowPageProjects),
		windowPageKey(windowPageProfiles),
	} {
		if err := p.deletePreferenceValue(r.Context(), s.Email, key); err != nil {
			slog.Error("preferences.reset failed", "email", s.Email, "key", key, "err", err)
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
	}
	p.cacheTheme(s.Email, defaultTheme)
	http.Redirect(w, r, "/settings", http.StatusSeeOther)
}

type appTokenView struct {
	ID       string
	Name     string
	Created  string
	LastUsed string
	Status   string
	Active   bool
}

func (p *Panel) appTokens(ctx context.Context) ([]appTokenView, error) {
	resp, err := p.clients.AppTokens.List(ctx, connect.NewRequest(&prosav1.AppTokensServiceListRequest{}))
	if err != nil {
		return nil, err
	}
	out := make([]appTokenView, 0, len(resp.Msg.Tokens))
	for _, tok := range resp.Msg.Tokens {
		view := appTokenView{
			ID:      tok.Id,
			Name:    tok.Name,
			Created: tokenTime(tok.CreatedAt),
			Status:  "active",
			Active:  true,
		}
		if tok.LastUsedAt != nil {
			view.LastUsed = relativeTime(tok.LastUsedAt.AsTime())
		} else {
			view.LastUsed = "never"
		}
		if tok.RevokedAt != nil {
			view.Status = "revoked"
			view.Active = false
		}
		out = append(out, view)
	}
	return out, nil
}

func tokenTime(ts *timestamppb.Timestamp) string {
	if ts == nil {
		return ""
	}
	t := ts.AsTime()
	if t.IsZero() {
		return ""
	}
	return t.Local().Format("2006-01-02 15:04")
}
