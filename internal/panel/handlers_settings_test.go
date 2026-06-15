package panel

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
)

type fakePreferencesService struct {
	prosav1connect.UnimplementedPreferencesServiceHandler
	mu        sync.Mutex
	prefs     map[string]string
	lastEmail string
	setCalls  int
}

func (f *fakePreferencesService) Get(_ context.Context, req *connect.Request[prosav1.PreferencesServiceGetRequest]) (*connect.Response[prosav1.PreferencesServiceGetResponse], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]string{}
	for k, v := range f.prefs {
		out[k] = v
	}
	return connect.NewResponse(&prosav1.PreferencesServiceGetResponse{Preferences: out}), nil
}

func (f *fakePreferencesService) Set(_ context.Context, req *connect.Request[prosav1.PreferencesServiceSetRequest]) (*connect.Response[prosav1.PreferencesServiceSetResponse], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.prefs == nil {
		f.prefs = map[string]string{}
	}
	f.prefs[req.Msg.Key] = req.Msg.Value
	f.lastEmail = req.Msg.OwnerEmail
	f.setCalls++
	return connect.NewResponse(&prosav1.PreferencesServiceSetResponse{}), nil
}

func (f *fakePreferencesService) Delete(_ context.Context, req *connect.Request[prosav1.PreferencesServiceDeleteRequest]) (*connect.Response[prosav1.PreferencesServiceDeleteResponse], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.prefs, req.Msg.Key)
	f.lastEmail = req.Msg.OwnerEmail
	return connect.NewResponse(&prosav1.PreferencesServiceDeleteResponse{}), nil
}

func (f *fakePreferencesService) snapshot() (calls int, email string, theme string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.setCalls, f.lastEmail, f.prefs["theme"]
}

func (f *fakePreferencesService) snapshotPrefs() map[string]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]string{}
	for k, v := range f.prefs {
		out[k] = v
	}
	return out
}

func newPanelWithPreferences(t *testing.T) (*Panel, *fakePreferencesService) {
	t.Helper()
	fake := &fakePreferencesService{}
	path, handler := prosav1connect.NewPreferencesServiceHandler(fake)
	mux := http.NewServeMux()
	mux.Handle(path, handler)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	p, err := New(Config{
		ServerURL:     server.URL,
		AdminToken:    "secret",
		CookieKey:     "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		OwnerEmails:   []string{"dev@localhost"},
		ListenAddr:    ":0",
		PublicBaseURL: "http://panel.test",
	})
	require.NoError(t, err)
	return p, fake
}

func TestSetThemePersistsValidChoice(t *testing.T) {
	t.Parallel()
	p, fake := newPanelWithPreferences(t)

	cookie := issueTestSessionCookie(t, p)
	req := httptest.NewRequest(http.MethodPost, "/settings/theme",
		strings.NewReader(url.Values{
			"theme": {"dracula"},
			"csrf":  {csrfForTestSessionCookie(t, p, cookie)},
		}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("HX-Request", "true")
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	calls, email, theme := fake.snapshot()
	require.Equal(t, 1, calls)
	require.Equal(t, "dev@localhost", email)
	require.Equal(t, "dracula", theme)
}

func TestSetThemeRejectsUnknownTheme(t *testing.T) {
	t.Parallel()
	p, fake := newPanelWithPreferences(t)

	cookie := issueTestSessionCookie(t, p)
	req := httptest.NewRequest(http.MethodPost, "/settings/theme",
		strings.NewReader(url.Values{
			"theme": {"neon-disco"},
			"csrf":  {csrfForTestSessionCookie(t, p, cookie)},
		}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
	calls, _, _ := fake.snapshot()
	require.Equal(t, 0, calls)
}

func TestSetThemeRequiresCSRF(t *testing.T) {
	t.Parallel()
	p, fake := newPanelWithPreferences(t)

	req := httptest.NewRequest(http.MethodPost, "/settings/theme",
		strings.NewReader("theme=dracula"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(issueTestSessionCookie(t, p))
	rec := httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusForbidden, rec.Code)
	calls, _, _ := fake.snapshot()
	require.Equal(t, 0, calls)
}

func TestSetDefaultWindowPersistsValidChoice(t *testing.T) {
	t.Parallel()
	p, fake := newPanelWithPreferences(t)

	cookie := issueTestSessionCookie(t, p)
	req := httptest.NewRequest(http.MethodPost, "/settings/window",
		strings.NewReader(url.Values{
			"window": {"7d"},
			"csrf":   {csrfForTestSessionCookie(t, p, cookie)},
		}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("HX-Request", "true")
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	prefs := fake.snapshotPrefs()
	require.Equal(t, "7d", prefs[windowDefaultKey])
}

func TestSetDefaultWindowToThirtyDaysClearsStoredDefault(t *testing.T) {
	t.Parallel()
	p, fake := newPanelWithPreferences(t)
	fake.mu.Lock()
	fake.prefs = map[string]string{windowDefaultKey: "7d"}
	fake.mu.Unlock()

	cookie := issueTestSessionCookie(t, p)
	req := httptest.NewRequest(http.MethodPost, "/settings/window",
		strings.NewReader(url.Values{
			"window": {"30d"},
			"csrf":   {csrfForTestSessionCookie(t, p, cookie)},
		}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("HX-Request", "true")
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	prefs := fake.snapshotPrefs()
	require.NotContains(t, prefs, windowDefaultKey)
}

func TestSetDefaultWindowRejectsUnknownWindow(t *testing.T) {
	t.Parallel()
	p, fake := newPanelWithPreferences(t)

	cookie := issueTestSessionCookie(t, p)
	req := httptest.NewRequest(http.MethodPost, "/settings/window",
		strings.NewReader(url.Values{
			"window": {"90d"},
			"csrf":   {csrfForTestSessionCookie(t, p, cookie)},
		}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
	prefs := fake.snapshotPrefs()
	require.NotContains(t, prefs, windowDefaultKey)
}

func TestResetPreferencesClearsThemeAndWindows(t *testing.T) {
	t.Parallel()
	p, fake := newPanelWithPreferences(t)
	fake.mu.Lock()
	fake.prefs = map[string]string{
		themePrefKey:                  "dracula",
		windowDefaultKey:              "7d",
		windowPageKey(windowPageHome): "12h",
	}
	fake.mu.Unlock()
	p.cacheTheme("dev@localhost", "dracula")

	cookie := issueTestSessionCookie(t, p)
	req := httptest.NewRequest(http.MethodPost, "/settings/reset",
		strings.NewReader(url.Values{
			"csrf": {csrfForTestSessionCookie(t, p, cookie)},
		}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusSeeOther, rec.Code)
	require.Equal(t, "/settings", rec.Header().Get("Location"))
	prefs := fake.snapshotPrefs()
	require.NotContains(t, prefs, themePrefKey)
	require.NotContains(t, prefs, windowDefaultKey)
	require.NotContains(t, prefs, windowPageKey(windowPageHome))

	req = httptest.NewRequest(http.MethodGet, "/settings", nil)
	req.AddCookie(cookie)
	rec = httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()
	require.Contains(t, body, `data-theme="colorblind"`)
	require.Contains(t, body, `value="30d" selected`)
}

func TestSettingsPageRendersThemePicker(t *testing.T) {
	t.Parallel()
	p, _ := newPanelWithPreferences(t)

	req := httptest.NewRequest(http.MethodGet, "/settings", nil)
	req.AddCookie(issueTestSessionCookie(t, p))
	rec := httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()
	require.Contains(t, body, `data-theme="colorblind"`)
	require.Contains(t, body, "theme-swatch")
	require.Contains(t, body, `value="dracula"`)
	require.Contains(t, body, "Solarized Dark")
	require.Contains(t, body, `action="/settings/reset"`)
	require.Contains(t, body, `fetch('/settings/window'`)
	require.Contains(t, body, "Default window")
	// Swatch hexes survive html/template's CSS sanitizer (not replaced by
	// its ZgotmplZ placeholder).
	require.Contains(t, body, "#bd93f9")
	require.NotContains(t, body, "ZgotmplZ")
}
