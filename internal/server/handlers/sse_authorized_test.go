package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

// authorized accepts an "Admin <token>" header with a case-insensitive
// scheme (now via strings.EqualFold) and a constant-time token compare.
// See issue #88.
func TestSSEAuthorized(t *testing.T) {
	h := &SSEHandler{AdminToken: "s3cr3t"}

	req := func(v string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/sse/events", nil)
		if v != "" {
			r.Header.Set("Authorization", v)
		}
		return r
	}

	require.True(t, h.authorized(req("Admin s3cr3t")))
	require.True(t, h.authorized(req("admin s3cr3t")), "scheme is case-insensitive")
	require.True(t, h.authorized(req("ADMIN s3cr3t")))

	require.False(t, h.authorized(req("Admin wrong")))
	require.False(t, h.authorized(req("Bearer s3cr3t")), "wrong scheme")
	require.False(t, h.authorized(req("")), "no header")
	require.False(t, h.authorized(req("Admin ")), "empty token")

	// No admin token configured → always rejected.
	require.False(t, (&SSEHandler{}).authorized(req("Admin anything")))
}
