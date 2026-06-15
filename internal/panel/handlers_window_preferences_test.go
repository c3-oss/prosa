package panel

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
)

func newPanelWithWindowPreferences(t *testing.T, prefs map[string]string) (*Panel, *fakePreferencesService) {
	t.Helper()
	fake := &fakePreferencesService{prefs: prefs}
	mux := http.NewServeMux()
	sp, sh := prosav1connect.NewSessionsServiceHandler(fakeSessionsService{})
	mux.Handle(sp, sh)
	dp, dh := prosav1connect.NewDevicesServiceHandler(fakeDevicesService{})
	mux.Handle(dp, dh)
	ap, ah := prosav1connect.NewAnalyticsServiceHandler(fakeAnalyticsService{})
	mux.Handle(ap, ah)
	pp, ph := prosav1connect.NewPreferencesServiceHandler(fake)
	mux.Handle(pp, ph)
	upstream := httptest.NewServer(mux)
	t.Cleanup(upstream.Close)

	p, err := New(Config{
		ServerURL:     upstream.URL,
		AdminToken:    "secret",
		CookieKey:     "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		OwnerEmails:   []string{"owner@example.com"},
		ListenAddr:    ":0",
		PublicBaseURL: "http://panel.test",
	})
	require.NoError(t, err)
	return p, fake
}

func TestWindowPreferencePersistsPerPage(t *testing.T) {
	p, fake := newPanelWithWindowPreferences(t, map[string]string{})
	cookie := cookieFor(t, p, "owner@example.com")

	req := httptest.NewRequest(http.MethodGet, "/?last=7d", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	prefs := fake.snapshotPrefs()
	require.Equal(t, "7d", prefs[windowPageKey(windowPageHome)])
	require.NotContains(t, prefs, windowPageKey(windowPageProjects))

	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(cookie)
	rec = httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), `value="7d"   selected`)

	req = httptest.NewRequest(http.MethodGet, "/projects", nil)
	req.AddCookie(cookie)
	rec = httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), `value="30d" selected`)
}

func TestWindowPreferenceClearFallsBackToDefault(t *testing.T) {
	p, fake := newPanelWithWindowPreferences(t, map[string]string{
		windowPageKey(windowPageHome): "7d",
	})
	cookie := cookieFor(t, p, "owner@example.com")

	req := httptest.NewRequest(http.MethodGet, "/?last=", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	prefs := fake.snapshotPrefs()
	require.NotContains(t, prefs, windowPageKey(windowPageHome))
	require.Contains(t, rec.Body.String(), `value="30d"  selected`)
}
