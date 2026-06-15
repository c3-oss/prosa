package panel

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"connectrpc.com/connect"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
)

const (
	defaultWindowValue = "30d"
	windowDefaultKey   = "window.default"
	windowPageHome     = "home"
	windowPageInsights = "insights"
	windowPageSessions = "sessions"
	windowPageProjects = "projects"
	windowPageProfiles = "profiles"
)

func windowPageKey(page string) string {
	return "window." + page
}

func validWindow(value string) bool {
	switch value {
	case "12h", "7d", "30d", "365d", "all":
		return true
	default:
		return false
	}
}

func defaultWindowFromPrefs(prefs map[string]string) string {
	if validWindow(prefs[windowDefaultKey]) {
		return prefs[windowDefaultKey]
	}
	return defaultWindowValue
}

func (p *Panel) resolvePageWindow(r *http.Request, page string) (last, defaultLast string) {
	defaultLast = defaultWindowValue
	s, ok := p.cookie.FromRequest(r)
	var prefs map[string]string
	if ok {
		var err error
		prefs, err = p.preferencesFor(r.Context(), s.Email)
		if err != nil {
			slog.Warn("preferences.get failed", "email", s.Email, "err", err)
		} else {
			defaultLast = defaultWindowFromPrefs(prefs)
		}
	}

	pageKey := windowPageKey(page)
	vals, hasLast := r.URL.Query()["last"]
	if hasLast {
		raw := strings.TrimSpace(lastValueOrDefault(vals, ""))
		if raw == "" {
			if ok {
				p.deletePreference(r.Context(), s.Email, pageKey)
			}
			return defaultLast, defaultLast
		}
		if !validWindow(raw) {
			return raw, defaultLast
		}
		if ok {
			if raw == defaultLast {
				p.deletePreference(r.Context(), s.Email, pageKey)
			} else {
				p.setPreference(r.Context(), s.Email, pageKey, raw)
			}
		}
		return raw, defaultLast
	}

	if validWindow(prefs[pageKey]) {
		return prefs[pageKey], defaultLast
	}
	return defaultLast, defaultLast
}

func (p *Panel) preferencesFor(ctx context.Context, email string) (map[string]string, error) {
	if email == "" {
		return nil, nil
	}
	resp, err := p.clients.Preferences.Get(ctx,
		connect.NewRequest(&prosav1.PreferencesServiceGetRequest{OwnerEmail: email}))
	if err != nil {
		return nil, err
	}
	return resp.Msg.Preferences, nil
}

func (p *Panel) setPreference(ctx context.Context, email, key, value string) {
	if _, err := p.clients.Preferences.Set(ctx,
		connect.NewRequest(&prosav1.PreferencesServiceSetRequest{
			OwnerEmail: email,
			Key:        key,
			Value:      value,
		})); err != nil {
		slog.Warn("preferences.set failed", "email", email, "key", key, "err", err)
	}
}

func (p *Panel) deletePreference(ctx context.Context, email, key string) {
	if _, err := p.clients.Preferences.Delete(ctx,
		connect.NewRequest(&prosav1.PreferencesServiceDeleteRequest{
			OwnerEmail: email,
			Key:        key,
		})); err != nil {
		slog.Warn("preferences.delete failed", "email", email, "key", key, "err", err)
	}
}

func clearFiltersTarget(basePath, last, defaultLast string) string {
	if last != "" && defaultLast != "" && last != defaultLast {
		return basePath + "?last="
	}
	return basePath
}
