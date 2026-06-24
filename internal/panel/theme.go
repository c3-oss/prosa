package panel

import (
	"context"
	"log/slog"
	"net/http"

	"connectrpc.com/connect"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
)

// defaultTheme is the Almanac (warm editorial) palette in :root, applied
// when the owner has never picked one or the stored value is unknown. It
// matches the chart palette so UI and charts read as one system.
const defaultTheme = "almanac"

// themePrefKey is the panel_preferences row key the theme lives under.
const themePrefKey = "theme"

// ThemeMeta drives the Settings picker. Swatch is a handful of
// representative hexes (accent + a few chart hues) shown as preview dots;
// the actual palette lives in tokens.css under [data-theme="<ID>"].
type ThemeMeta struct {
	ID     string
	Label  string
	Hint   string
	Swatch []string
}

// Themes is the single source of truth for the catalog: the picker
// renders from it and the Set handler validates against it, so the two
// can never drift. Order here is the order shown on the Settings page.
var Themes = []ThemeMeta{
	{"almanac", "Almanac", "Warm editorial (default)", []string{"#2f8f7f", "#c9952f", "#7aaa6d", "#cf6b4a"}},
	{"colorblind", "Colorblind", "Colorblind-safe Okabe-Ito", []string{"#56b4e9", "#e69f00", "#1fb894", "#ef6c1a"}},
	{"light", "Light", "Always light", []string{"#4a5af0", "#56b4e9", "#e69f00", "#009e73"}},
	{"nord", "Nord", "Cool arctic", []string{"#88c0d0", "#ebcb8b", "#a3be8c", "#bf616a"}},
	{"solarized-dark", "Solarized Dark", "Solarized dark", []string{"#268bd2", "#b58900", "#859900", "#dc322f"}},
	{"solarized-light", "Solarized Light", "Solarized light", []string{"#268bd2", "#b58900", "#859900", "#cb4b16"}},
	{"dracula", "Dracula", "Purple night", []string{"#bd93f9", "#ffb86c", "#50fa7b", "#ff5555"}},
	{"gruvbox", "Gruvbox", "Warm retro", []string{"#fabd2f", "#fe8019", "#b8bb26", "#fb4934"}},
	{"high-contrast", "High Contrast", "Maximum contrast", []string{"#ffd400", "#4dd2ff", "#00e676", "#ff3b30"}},
	{"system", "System", "Follow OS preference", []string{"#56b4e9", "#e69f00", "#1fb894", "#ef6c1a"}},
}

// validTheme reports whether id is a known theme id.
func validTheme(id string) bool {
	for _, t := range Themes {
		if t.ID == id {
			return true
		}
	}
	return false
}

// currentTheme resolves the theme for the request's owner, defaulting to
// almanac for anonymous requests or on any lookup failure.
func (p *Panel) currentTheme(r *http.Request) string {
	s, ok := p.cookie.FromRequest(r)
	if !ok {
		return defaultTheme
	}
	return p.themeFor(r.Context(), s.Email)
}

// themeFor returns the owner's stored theme, hitting the server only on a
// cache miss. The cache is invalidated by handleSetTheme on every write,
// so a single-process panel never serves a stale value to its own owner.
func (p *Panel) themeFor(ctx context.Context, email string) string {
	if email == "" {
		return defaultTheme
	}
	p.themeMu.RLock()
	cached, ok := p.themeCache[email]
	p.themeMu.RUnlock()
	if ok {
		return cached
	}
	resp, err := p.clients.Preferences.Get(ctx,
		connect.NewRequest(&prosav1.PreferencesServiceGetRequest{OwnerEmail: email}))
	if err != nil {
		slog.Error("preferences.get failed", "email", email, "err", err)
		return defaultTheme
	}
	theme := resp.Msg.Preferences[themePrefKey]
	if !validTheme(theme) {
		theme = defaultTheme
	}
	p.cacheTheme(email, theme)
	return theme
}

func (p *Panel) cacheTheme(email, theme string) {
	p.themeMu.Lock()
	if p.themeCache == nil {
		p.themeCache = make(map[string]string)
	}
	p.themeCache[email] = theme
	p.themeMu.Unlock()
}
