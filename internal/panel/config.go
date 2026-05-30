// Package panel hosts the web UI for prosa. The panel is a thin
// templ + HTMX client of the Connect API exposed by prosa-server; it
// owns OAuth, cookies, and the HTML rendering — nothing else.
package panel

import (
	"errors"
	"fmt"
	"os"
	"strings"
)

// Config carries every knob the panel binary reads from the
// environment. All values are loaded once at startup; runtime mutation
// is not supported.
type Config struct {
	// ListenAddr is where the panel's HTTP server binds.
	// Env: PROSA_PANEL_LISTEN_ADDR (default ":8080").
	ListenAddr string

	// ServerURL is the prosa-server Connect base URL.
	// Env: PROSA_PANEL_SERVER_URL (default "http://localhost:7070").
	ServerURL string

	// AdminToken is shared with prosa-server; the panel attaches it as
	// `Authorization: Admin <token>` on every Connect call so the
	// server scopes the request as "owner" (not device).
	// Env: PROSA_ADMIN_TOKEN (required).
	AdminToken string

	// OAuth GitHub client credentials. Required unless DevLoginEmail
	// is set.
	// Env: PROSA_PANEL_OAUTH_GH_CLIENT_ID / PROSA_PANEL_OAUTH_GH_SECRET.
	OAuthGHClientID string
	OAuthGHSecret   string

	// PublicBaseURL is the absolute URL the panel is reachable at; used
	// to build the OAuth callback. Default derived from ListenAddr +
	// "http://localhost".
	// Env: PROSA_PANEL_PUBLIC_URL (optional).
	PublicBaseURL string

	// CookieKey is the HMAC key for session cookies. Hex-encoded; 32+
	// bytes recommended. Required.
	// Env: PROSA_PANEL_COOKIE_KEY.
	CookieKey string

	// CookieSecure flags the `Secure` cookie attribute. False is OK in
	// local dev over plain http; turn on in production.
	// Env: PROSA_PANEL_COOKIE_SECURE ("true"/"1").
	CookieSecure bool

	// OwnerEmails is the email whitelist. CSV of lowercase emails.
	// Anyone whose verified GitHub primary email isn't in here gets a
	// 403 and the session is not started.
	// Env: PROSA_OWNER_EMAILS (default "hi@caian.org").
	OwnerEmails []string

	// DevLoginEmail, when set, enables a local-only POST /dev-login
	// route that skips GitHub OAuth entirely and sets the session
	// cookie directly. Email must be in OwnerEmails. Boot logs a loud
	// warning when this is non-empty.
	// Env: PROSA_PANEL_DEV_LOGIN (optional; do NOT use in production).
	DevLoginEmail string
}

// Load reads the environment and returns a validated Config.
func Load() (Config, error) {
	cfg := Config{
		ListenAddr:      envOr("PROSA_PANEL_LISTEN_ADDR", ":8080"),
		ServerURL:       envOr("PROSA_PANEL_SERVER_URL", "http://localhost:7070"),
		AdminToken:      os.Getenv("PROSA_ADMIN_TOKEN"),
		OAuthGHClientID: os.Getenv("PROSA_PANEL_OAUTH_GH_CLIENT_ID"),
		OAuthGHSecret:   os.Getenv("PROSA_PANEL_OAUTH_GH_SECRET"),
		PublicBaseURL:   os.Getenv("PROSA_PANEL_PUBLIC_URL"),
		CookieKey:       os.Getenv("PROSA_PANEL_COOKIE_KEY"),
		CookieSecure:    parseBool(os.Getenv("PROSA_PANEL_COOKIE_SECURE")),
		OwnerEmails:     parseEmails(envOr("PROSA_OWNER_EMAILS", "hi@caian.org")),
		DevLoginEmail:   strings.ToLower(strings.TrimSpace(os.Getenv("PROSA_PANEL_DEV_LOGIN"))),
	}

	if cfg.AdminToken == "" {
		return Config{}, errors.New("PROSA_ADMIN_TOKEN is required")
	}
	if cfg.CookieKey == "" {
		return Config{}, errors.New("PROSA_PANEL_COOKIE_KEY is required (use `openssl rand -hex 32`)")
	}
	if len(cfg.OwnerEmails) == 0 {
		return Config{}, errors.New("PROSA_OWNER_EMAILS yielded an empty whitelist")
	}
	if cfg.DevLoginEmail == "" {
		// Only enforce the OAuth creds when no dev-login is configured.
		if cfg.OAuthGHClientID == "" || cfg.OAuthGHSecret == "" {
			return Config{}, errors.New("PROSA_PANEL_OAUTH_GH_CLIENT_ID and PROSA_PANEL_OAUTH_GH_SECRET are required (or set PROSA_PANEL_DEV_LOGIN for local bypass)")
		}
	} else if !cfg.IsOwnerEmail(cfg.DevLoginEmail) {
		return Config{}, fmt.Errorf("PROSA_PANEL_DEV_LOGIN=%q is not in PROSA_OWNER_EMAILS", cfg.DevLoginEmail)
	}
	if cfg.PublicBaseURL == "" {
		cfg.PublicBaseURL = "http://localhost" + cfg.ListenAddr
	}
	return cfg, nil
}

// IsOwnerEmail returns true when email (case-insensitive) is in the
// whitelist.
func (c Config) IsOwnerEmail(email string) bool {
	email = strings.ToLower(strings.TrimSpace(email))
	for _, e := range c.OwnerEmails {
		if e == email {
			return true
		}
	}
	return false
}

func envOr(key, fallback string) string {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	return v
}

func parseBool(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func parseEmails(csv string) []string {
	parts := strings.Split(csv, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.ToLower(strings.TrimSpace(p))
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
