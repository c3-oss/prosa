package panel

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
)

func TestIsLoopbackCallback(t *testing.T) {
	ok := []string{
		"http://127.0.0.1:54321/callback",
		"http://localhost:8080/callback",
		"http://127.0.0.1/callback",
	}
	for _, raw := range ok {
		u, err := url.Parse(raw)
		require.NoError(t, err)
		require.True(t, isLoopbackCallback(u), raw)
	}

	bad := []string{
		"https://127.0.0.1/callback", // not http
		"http://evil.example/callback",
		"http://127.0.0.1/other",
		"http://localhost/", // wrong path
	}
	for _, raw := range bad {
		u, err := url.Parse(raw)
		require.NoError(t, err)
		require.False(t, isLoopbackCallback(u), raw)
	}
}

// The panel must refuse to redirect to a non-loopback target even if the
// server (incorrectly) returns one — defense-in-depth against an open
// redirect. See issue #136.
func TestCliAuthorizeApproveRejectsNonLoopbackRedirect(t *testing.T) {
	t.Parallel()
	fake := &fakeAuthService{redirectURI: "http://evil.example/callback"}
	path, handler := prosav1connect.NewAuthServiceHandler(fake)
	authMux := http.NewServeMux()
	authMux.Handle(path, handler)
	authServer := httptest.NewServer(authMux)
	t.Cleanup(authServer.Close)

	p, err := New(Config{
		ServerURL:     authServer.URL,
		AdminToken:    "secret",
		CookieKey:     "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		OwnerEmails:   []string{"dev@localhost"},
		ListenAddr:    ":0",
		PublicBaseURL: "http://panel.test",
	})
	require.NoError(t, err)

	cookie := issueTestSessionCookie(t, p)
	req := httptest.NewRequest(http.MethodPost, "/cli/authorize/approve",
		strings.NewReader(url.Values{
			"request_id": {"req-123"},
			"csrf":       {csrfForTestSessionCookie(t, p, cookie)},
		}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	require.NotContains(t, rec.Header().Get("Location"), "evil.example")
}
