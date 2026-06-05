package panel

import "net/http"

// handleSettings renders the single-card settings page: who is logged
// in plus the logout form. The cookie is already validated by
// requireSession, so FromRequest should always succeed here; the ok
// branch is defensive against future routing tweaks.
func (p *Panel) handleSettings(w http.ResponseWriter, r *http.Request) {
	email := "unknown"
	if s, ok := p.cookie.FromRequest(r); ok {
		email = s.Email
	}
	p.render(w, "settings", map[string]any{
		"Title": "Settings",
		"Nav":   "settings",
		"Email": email,
		"CSRF":  p.csrfFromRequest(r),
	})
}
