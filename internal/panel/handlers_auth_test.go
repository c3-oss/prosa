package panel

import (
	"context"
	"net/http"
	"net/http/httptest"
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
}

func (f *fakeAuthService) ApproveLogin(_ context.Context, req *connect.Request[prosav1.ApproveLoginRequest]) (*connect.Response[prosav1.ApproveLoginResponse], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.adminAuth = req.Header().Get("Authorization")
	f.requestID = req.Msg.RequestId
	return connect.NewResponse(&prosav1.ApproveLoginResponse{
		Code:        "auth-code",
		RedirectUri: "http://127.0.0.1:49152/callback",
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

	req := httptest.NewRequest(http.MethodPost, "/cli/authorize/approve",
		strings.NewReader("request_id=req-123"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(issueTestSessionCookie(t, p))
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

func TestSafeNextPath(t *testing.T) {
	t.Parallel()
	require.Equal(t, "/cli/authorize?request_id=abc", safeNextPath("/cli/authorize?request_id=abc"))
	require.Equal(t, "", safeNextPath(""))
	require.Equal(t, "", safeNextPath("https://evil.example/"))
	require.Equal(t, "", safeNextPath("//evil.example/"))
}
