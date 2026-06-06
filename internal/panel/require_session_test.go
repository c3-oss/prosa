package panel

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/internal/panel/session"
)

func newPanelWithOwners(t *testing.T, owners ...string) *Panel {
	t.Helper()
	p, err := New(Config{
		ServerURL:     "http://server.test",
		AdminToken:    "secret",
		CookieKey:     "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		OwnerEmails:   owners,
		ListenAddr:    ":0",
		PublicBaseURL: "http://panel.test",
	})
	require.NoError(t, err)
	return p
}

func cookieFor(t *testing.T, p *Panel, email string) *http.Cookie {
	t.Helper()
	rec := httptest.NewRecorder()
	require.NoError(t, p.cookie.Issue(rec, email))
	for _, c := range rec.Result().Cookies() {
		if c.Name == session.CookieName {
			return c
		}
	}
	t.Fatal("session cookie not issued")
	return nil
}

// requireSession must re-check the owner whitelist on every request, so an
// HMAC-valid cookie whose email was removed from PROSA_OWNER_EMAILS is
// rejected immediately rather than honored until its TTL. See issue #122.
func TestRequireSessionRechecksOwnerWhitelist(t *testing.T) {
	issuer := newPanelWithOwners(t, "owner@example.com")
	cookie := cookieFor(t, issuer, "owner@example.com")

	hit := func(p *Panel) (*httptest.ResponseRecorder, bool) {
		called := false
		h := p.requireSession(func(w http.ResponseWriter, _ *http.Request) {
			called = true
			w.WriteHeader(http.StatusOK)
		})
		req := httptest.NewRequest(http.MethodGet, "/devices", nil)
		req.AddCookie(cookie)
		rr := httptest.NewRecorder()
		h(rr, req)
		return rr, called
	}

	// Still whitelisted → handler runs.
	rr, called := hit(issuer)
	require.True(t, called)
	require.Equal(t, http.StatusOK, rr.Code)

	// Same cookie key, but the email is no longer whitelisted → rejected.
	revoked := newPanelWithOwners(t, "someone-else@example.com")
	rr, called = hit(revoked)
	require.False(t, called, "handler must not run for a de-whitelisted email")
	require.Equal(t, http.StatusFound, rr.Code)
	require.Equal(t, "/login", rr.Header().Get("Location"))
}
