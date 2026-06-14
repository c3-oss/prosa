package panel

import (
	"log/slog"
	"net/http"
	"strings"

	"connectrpc.com/connect"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
)

// handleSettings renders the settings page: who is logged in, the logout
// form, and the theme picker. The cookie is already validated by
// requireSession, so FromRequest should always succeed here; the ok
// branch is defensive against future routing tweaks.
func (p *Panel) handleSettings(w http.ResponseWriter, r *http.Request) {
	email := "unknown"
	if s, ok := p.cookie.FromRequest(r); ok {
		email = s.Email
	}
	theme := p.currentTheme(r)
	p.render(w, r, "settings", map[string]any{
		"Title":   "Settings",
		"Nav":     "settings",
		"Email":   email,
		"CSRF":    p.csrfFromRequest(r),
		"Themes":  Themes,
		"Current": theme,
		"Theme":   theme,
	})
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
	if _, err := p.clients.Preferences.Set(r.Context(),
		connect.NewRequest(&prosav1.PreferencesServiceSetRequest{
			OwnerEmail: s.Email,
			Key:        themePrefKey,
			Value:      theme,
		})); err != nil {
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
