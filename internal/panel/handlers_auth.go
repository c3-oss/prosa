package panel

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"

	"github.com/c3-oss/prosa/internal/panel/oauth"
)

// handleLogin renders the login page. Read-only; the only POST surface
// is the GitHub redirect (a link) plus the optional dev-login button.
func (p *Panel) handleLogin(w http.ResponseWriter, r *http.Request) {
	if _, ok := p.cookie.FromRequest(r); ok {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	data := map[string]any{
		"Title":           "Login",
		"Tagline":         "your work log",
		"DevLoginEnabled": p.cfg.DevLoginEmail != "",
		"DevLoginEmail":   p.cfg.DevLoginEmail,
		"Error":           r.URL.Query().Get("error"),
	}
	if p.cfg.OAuthGHClientID != "" {
		state, err := newState()
		if err != nil {
			slog.Error("login state mint failed", "err", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		http.SetCookie(w, &http.Cookie{
			Name:     "prosa_oauth_state",
			Value:    state,
			Path:     "/",
			MaxAge:   600,
			HttpOnly: true,
			Secure:   p.cfg.CookieSecure,
			SameSite: http.SameSiteLaxMode,
		})
		data["GitHubURL"] = oauth.GitHubAuthURL(
			p.cfg.OAuthGHClientID,
			p.cfg.PublicBaseURL+"/oauth/github/callback",
			state,
		)
	}
	p.render(w, "login", data)
}

// handleGitHubCallback exchanges the code and lights up the session
// when the verified email is in the whitelist.
func (p *Panel) handleGitHubCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if e := q.Get("error"); e != "" {
		redirectLoginError(w, r, e)
		return
	}
	code := q.Get("code")
	state := q.Get("state")
	if code == "" || state == "" {
		redirectLoginError(w, r, "missing code or state")
		return
	}
	cookie, err := r.Cookie("prosa_oauth_state")
	if err != nil || cookie.Value != state {
		redirectLoginError(w, r, "state mismatch")
		return
	}
	// One-shot cookie; clear it.
	http.SetCookie(w, &http.Cookie{
		Name: "prosa_oauth_state", Value: "", Path: "/", MaxAge: -1,
	})

	tok, err := oauth.GitHubExchange(r.Context(), oauth.ExchangeArgs{
		ClientID:     p.cfg.OAuthGHClientID,
		ClientSecret: p.cfg.OAuthGHSecret,
		RedirectURI:  p.cfg.PublicBaseURL + "/oauth/github/callback",
		Code:         code,
	})
	if err != nil {
		slog.Error("oauth exchange failed", "err", err)
		redirectLoginError(w, r, "github exchange failed")
		return
	}
	email, err := oauth.GitHubPrimaryEmail(r.Context(), tok)
	if err != nil {
		slog.Error("oauth email fetch failed", "err", err)
		redirectLoginError(w, r, "could not read github email")
		return
	}
	if !p.cfg.IsOwnerEmail(email) {
		slog.Warn("login denied — email not in whitelist", "email", email)
		http.Error(w, fmt.Sprintf("403 — %s is not on the owner whitelist", email), http.StatusForbidden)
		return
	}
	if err := p.cookie.Issue(w, email); err != nil {
		slog.Error("cookie issue failed", "err", err)
		http.Error(w, "internal panel error", http.StatusInternalServerError)
		return
	}
	slog.Info("login ok", "email", email, "source", "github")
	http.Redirect(w, r, "/", http.StatusFound)
}

// handleDevLogin sets the cookie without going through GitHub. The
// route only exists when PROSA_PANEL_DEV_LOGIN is non-empty.
func (p *Panel) handleDevLogin(w http.ResponseWriter, r *http.Request) {
	if p.cfg.DevLoginEmail == "" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := p.cookie.Issue(w, p.cfg.DevLoginEmail); err != nil {
		slog.Error("dev-login cookie issue failed", "err", err)
		http.Error(w, "internal panel error", http.StatusInternalServerError)
		return
	}
	slog.Warn("dev-login used — bypassing OAuth", "email", p.cfg.DevLoginEmail,
		"remote", r.RemoteAddr)
	http.Redirect(w, r, "/", http.StatusFound)
}

// handleLogout drops the cookie and bounces back to /login.
func (p *Panel) handleLogout(w http.ResponseWriter, r *http.Request) {
	p.cookie.Clear(w)
	http.Redirect(w, r, "/login", http.StatusFound)
}

func redirectLoginError(w http.ResponseWriter, r *http.Request, msg string) {
	url := &url.URL{Path: "/login", RawQuery: "error=" + queryEscape(msg)}
	http.Redirect(w, r, url.String(), http.StatusFound)
}

func queryEscape(s string) string {
	return url.QueryEscape(s)
}

func newState() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", errors.New("entropy unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
