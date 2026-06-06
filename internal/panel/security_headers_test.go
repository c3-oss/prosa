package panel

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSecurityHeaders(t *testing.T) {
	for _, secure := range []bool{false, true} {
		p, err := New(Config{
			ServerURL:     "http://server.test",
			AdminToken:    "secret",
			CookieKey:     "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			OwnerEmails:   []string{"owner@example.com"},
			ListenAddr:    ":0",
			PublicBaseURL: "http://panel.test",
			CookieSecure:  secure,
		})
		require.NoError(t, err)

		h := p.securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		}))
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))

		require.Equal(t, "frame-ancestors 'none'", rr.Header().Get("Content-Security-Policy"))
		require.Equal(t, "DENY", rr.Header().Get("X-Frame-Options"))
		require.Equal(t, "nosniff", rr.Header().Get("X-Content-Type-Options"))
		require.Equal(t, "same-origin", rr.Header().Get("Referrer-Policy"))
		if secure {
			require.NotEmpty(t, rr.Header().Get("Strict-Transport-Security"),
				"HSTS must be set when cookies are Secure")
		} else {
			require.Empty(t, rr.Header().Get("Strict-Transport-Security"),
				"HSTS must be omitted over plain HTTP")
		}
	}
}
