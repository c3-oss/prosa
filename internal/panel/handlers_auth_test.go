package panel

import (
	"context"
	"io"
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
	"github.com/c3-oss/prosa/internal/panel/session"
)

type fakeAuthService struct {
	prosav1connect.UnimplementedAuthServiceHandler
	mu        sync.Mutex
	adminAuth string
	requestID string
	// redirectURI overrides the ApproveLogin redirect; empty uses the
	// default loopback callback.
	redirectURI string
}

func (f *fakeAuthService) ApproveLogin(_ context.Context, req *connect.Request[prosav1.ApproveLoginRequest]) (*connect.Response[prosav1.ApproveLoginResponse], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.adminAuth = req.Header().Get("Authorization")
	f.requestID = req.Msg.RequestId
	redirect := f.redirectURI
	if redirect == "" {
		redirect = "http://127.0.0.1:49152/callback"
	}
	return connect.NewResponse(&prosav1.ApproveLoginResponse{
		Code:        "auth-code",
		RedirectUri: redirect,
		ClientState: "client-state",
	}), nil
}

func (f *fakeAuthService) snapshot() (adminAuth, requestID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.adminAuth, f.requestID
}

func TestCliAuthorizeApproveRedirectsToCallback(t *testing.T) {
	t.Parallel()
	fake := &fakeAuthService{}
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

	require.Equal(t, http.StatusFound, rec.Code)
	adminAuth, requestID := fake.snapshot()
	require.Equal(t, "Admin secret", adminAuth)
	require.Equal(t, "req-123", requestID)
	require.Equal(t,
		"http://127.0.0.1:49152/callback?code=auth-code&state=client-state",
		rec.Header().Get("Location"))
}

func TestCliAuthorizeApproveRejectsMissingCSRF(t *testing.T) {
	t.Parallel()
	fake := &fakeAuthService{}
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

	req := httptest.NewRequest(http.MethodPost, "/cli/authorize/approve",
		strings.NewReader("request_id=req-123"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(issueTestSessionCookie(t, p))
	rec := httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusForbidden, rec.Code)
	_, requestID := fake.snapshot()
	require.Empty(t, requestID)
}

func TestLoginSetsOAuthStateCookieForGitHubCallback(t *testing.T) {
	t.Parallel()
	p, err := New(Config{
		ServerURL:       "http://server.test",
		AdminToken:      "secret",
		CookieKey:       "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		OwnerEmails:     []string{"dev@localhost"},
		ListenAddr:      ":0",
		PublicBaseURL:   "http://panel.test",
		OAuthGHClientID: "github-client",
		OAuthGHSecret:   "github-secret",
	})
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodGet, "/login", nil)
	rec := httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	res := rec.Result()
	defer res.Body.Close()
	state := findCookie(res.Cookies(), "prosa_oauth_state")
	require.NotNil(t, state)
	require.NotEmpty(t, state.Value)
	require.Equal(t, "/", state.Path)
	require.Equal(t, 600, state.MaxAge)
	require.True(t, state.HttpOnly)
	require.Equal(t, http.SameSiteLaxMode, state.SameSite)

	body, err := io.ReadAll(res.Body)
	require.NoError(t, err)
	require.Contains(t, string(body), "https://github.com/login/oauth/authorize")
	require.Contains(t, string(body), "state="+url.QueryEscape(state.Value))
}

func TestDevLoginRequiresLoginCSRF(t *testing.T) {
	t.Parallel()
	p, err := New(Config{
		ServerURL:     "http://server.test",
		AdminToken:    "secret",
		CookieKey:     "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		OwnerEmails:   []string{"dev@localhost"},
		ListenAddr:    ":0",
		PublicBaseURL: "http://panel.test",
		DevLoginEmail: "dev@localhost",
	})
	require.NoError(t, err)

	missing := httptest.NewRequest(http.MethodPost, "/dev-login", nil)
	missingRec := httptest.NewRecorder()
	p.mux.ServeHTTP(missingRec, missing)
	require.Equal(t, http.StatusForbidden, missingRec.Code)

	loginReq := httptest.NewRequest(http.MethodGet, "/login", nil)
	loginRec := httptest.NewRecorder()
	p.mux.ServeHTTP(loginRec, loginReq)
	require.Equal(t, http.StatusOK, loginRec.Code)
	loginRes := loginRec.Result()
	defer loginRes.Body.Close()
	body, err := io.ReadAll(loginRes.Body)
	require.NoError(t, err)
	csrf := extractHiddenCSRF(t, string(body))

	post := httptest.NewRequest(http.MethodPost, "/dev-login",
		strings.NewReader(url.Values{"csrf": {csrf}}.Encode()))
	post.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	for _, c := range loginRes.Cookies() {
		post.AddCookie(c)
	}
	postRec := httptest.NewRecorder()
	p.mux.ServeHTTP(postRec, post)
	require.Equal(t, http.StatusFound, postRec.Code)
	require.NotNil(t, findCookie(postRec.Result().Cookies(), session.CookieName))
}

func TestFaviconDoesNotRefreshLoginCSRF(t *testing.T) {
	t.Parallel()
	p, err := New(Config{
		ServerURL:     "http://server.test",
		AdminToken:    "secret",
		CookieKey:     "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		OwnerEmails:   []string{"dev@localhost"},
		ListenAddr:    ":0",
		PublicBaseURL: "http://panel.test",
		DevLoginEmail: "dev@localhost",
	})
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodGet, "/favicon.ico", nil)
	rec := httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)
	require.Equal(t, http.StatusNoContent, rec.Code)
	require.Nil(t, findCookie(rec.Result().Cookies(), loginCSRFName))
}

func issueTestSessionCookie(t *testing.T, p *Panel) *http.Cookie {
	t.Helper()
	rec := httptest.NewRecorder()
	require.NoError(t, p.cookie.Issue(rec, "dev@localhost"))
	res := rec.Result()
	defer res.Body.Close()
	for _, c := range res.Cookies() {
		if c.Name == session.CookieName {
			return c
		}
	}
	t.Fatal("session cookie not issued")
	return nil
}

func csrfForTestSessionCookie(t *testing.T, p *Panel, c *http.Cookie) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(c)
	s, ok := p.cookie.FromRequest(req)
	require.True(t, ok)
	require.NotEmpty(t, s.CSRF)
	return s.CSRF
}

func extractHiddenCSRF(t *testing.T, body string) string {
	t.Helper()
	const marker = `name="csrf" value="`
	start := strings.Index(body, marker)
	require.NotEqual(t, -1, start)
	start += len(marker)
	end := strings.IndexByte(body[start:], '"')
	require.NotEqual(t, -1, end)
	return body[start : start+end]
}

func findCookie(cookies []*http.Cookie, name string) *http.Cookie {
	for _, c := range cookies {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func TestSafeNextPath(t *testing.T) {
	t.Parallel()
	require.Equal(t, "/cli/authorize?request_id=abc", safeNextPath("/cli/authorize?request_id=abc"))
	require.Equal(t, "", safeNextPath(""))
	require.Equal(t, "", safeNextPath("https://evil.example/"))
	require.Equal(t, "", safeNextPath("//evil.example/"))
}
