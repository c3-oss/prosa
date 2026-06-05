package panel

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
)

const loginCSRFName = "prosa_panel_login_csrf"

func (p *Panel) csrfProtected(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && !p.validCSRF(r) {
			http.Error(w, "invalid csrf token", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

func (p *Panel) validCSRF(r *http.Request) bool {
	got := strings.TrimSpace(r.FormValue("csrf"))
	want := ""
	if s, ok := p.cookie.FromRequest(r); ok {
		want = s.CSRF
	} else if c, err := r.Cookie(loginCSRFName); err == nil {
		want = c.Value
	}
	return equalCSRF(got, want)
}

func (p *Panel) csrfFromRequest(r *http.Request) string {
	if s, ok := p.cookie.FromRequest(r); ok {
		return s.CSRF
	}
	return ""
}

func equalCSRF(got, want string) bool {
	if got == "" || want == "" {
		return false
	}
	gotHash := sha256.Sum256([]byte(got))
	wantHash := sha256.Sum256([]byte(want))
	return subtle.ConstantTimeCompare(gotHash[:], wantHash[:]) == 1
}

func setLoginCSRFCookie(w http.ResponseWriter, secure bool) (string, error) {
	token, err := newCSRFToken()
	if err != nil {
		return "", err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     loginCSRFName,
		Value:    token,
		Path:     "/",
		MaxAge:   600,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	})
	return token, nil
}

func clearLoginCSRFCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     loginCSRFName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	})
}

func newCSRFToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", errors.New("entropy unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
