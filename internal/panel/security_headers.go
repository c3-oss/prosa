package panel

import "net/http"

// securityHeaders wraps the panel mux and sets defense-in-depth response
// headers on every response (issue #117):
//
//   - X-Frame-Options: DENY + CSP frame-ancestors 'none' — block clickjacking
//     of the device-rename/revoke and CLI-approval forms.
//   - X-Content-Type-Options: nosniff — stop MIME confusion of HTMX swaps.
//   - Referrer-Policy: same-origin — don't leak panel URLs cross-origin.
//   - Strict-Transport-Security — only when cookies are already Secure (i.e.
//     served over TLS); harmless to omit behind a TLS-terminating proxy that
//     sets its own HSTS, dangerous to send over plain HTTP in dev.
//
// The CSP is intentionally limited to frame-ancestors for now. A
// script-containment policy (default-src/script-src 'self') would require
// 'unsafe-eval' because the bundled Alpine.js evaluates expressions at
// runtime — which would defeat most of the containment it buys — so a
// fuller CSP is left to a follow-up that swaps in Alpine's CSP build.
func (p *Panel) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", "frame-ancestors 'none'")
		h.Set("X-Frame-Options", "DENY")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		if p.cfg.CookieSecure {
			h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}
