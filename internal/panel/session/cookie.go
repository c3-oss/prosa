// Package session implements the panel's HMAC-signed cookie.
//
// Cookie value is base64(json(payload)) + "." + base64(hmac-sha256).
// We sign payload bytes (not the encoded form) so encoding tweaks
// don't void existing cookies.
package session

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"
)

const (
	// CookieName is the panel session cookie key.
	CookieName = "prosa_panel"
	// DefaultTTL mirrors INTENT §6: 30 days.
	DefaultTTL = 30 * 24 * time.Hour
)

// Session is the payload we sign into the cookie. Email is the
// verified owner email; everything else is derived.
type Session struct {
	Email     string    `json:"email"`
	IssuedAt  time.Time `json:"iat"`
	ExpiresAt time.Time `json:"exp"`
}

// Manager produces and validates cookies. Construct once with the
// HMAC key + secure flag and reuse across handlers.
type Manager struct {
	key    []byte
	secure bool
}

// NewManager builds a Manager. hexKey is the hex-encoded HMAC secret;
// fall back to using its raw bytes if it isn't actually hex.
func NewManager(hexKey string, secure bool) *Manager {
	key, err := decodeHex(hexKey)
	if err != nil {
		key = []byte(hexKey)
	}
	return &Manager{key: key, secure: secure}
}

// Issue mints a fresh signed cookie for email and writes it to w.
func (m *Manager) Issue(w http.ResponseWriter, email string) error {
	now := time.Now().UTC()
	s := Session{
		Email:     email,
		IssuedAt:  now,
		ExpiresAt: now.Add(DefaultTTL),
	}
	val, err := m.encode(s)
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    val,
		Path:     "/",
		Expires:  s.ExpiresAt,
		HttpOnly: true,
		Secure:   m.secure,
		SameSite: http.SameSiteLaxMode,
	})
	return nil
}

// Clear unsets the cookie on the response.
func (m *Manager) Clear(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   m.secure,
		SameSite: http.SameSiteLaxMode,
	})
}

// FromRequest returns the verified Session attached to r, or false
// when the cookie is missing / tampered / expired.
func (m *Manager) FromRequest(r *http.Request) (Session, bool) {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return Session{}, false
	}
	s, err := m.decode(c.Value)
	if err != nil {
		return Session{}, false
	}
	if time.Now().UTC().After(s.ExpiresAt) {
		return Session{}, false
	}
	return s, true
}

func (m *Manager) encode(s Session) (string, error) {
	body, err := json.Marshal(s)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, m.key)
	mac.Write(body)
	sig := mac.Sum(nil)
	return base64.RawURLEncoding.EncodeToString(body) + "." +
		base64.RawURLEncoding.EncodeToString(sig), nil
}

func (m *Manager) decode(value string) (Session, error) {
	dot := -1
	for i := len(value) - 1; i >= 0; i-- {
		if value[i] == '.' {
			dot = i
			break
		}
	}
	if dot <= 0 || dot == len(value)-1 {
		return Session{}, errors.New("malformed cookie")
	}
	body, err := base64.RawURLEncoding.DecodeString(value[:dot])
	if err != nil {
		return Session{}, fmt.Errorf("decode body: %w", err)
	}
	sig, err := base64.RawURLEncoding.DecodeString(value[dot+1:])
	if err != nil {
		return Session{}, fmt.Errorf("decode sig: %w", err)
	}
	mac := hmac.New(sha256.New, m.key)
	mac.Write(body)
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return Session{}, errors.New("signature mismatch")
	}
	var s Session
	if err := json.Unmarshal(body, &s); err != nil {
		return Session{}, fmt.Errorf("unmarshal: %w", err)
	}
	return s, nil
}

func decodeHex(s string) ([]byte, error) {
	out := make([]byte, len(s)/2)
	for i := 0; i < len(out); i++ {
		hi, ok := hexVal(s[2*i])
		if !ok {
			return nil, errors.New("not hex")
		}
		lo, ok := hexVal(s[2*i+1])
		if !ok {
			return nil, errors.New("not hex")
		}
		out[i] = hi<<4 | lo
	}
	return out, nil
}

func hexVal(b byte) (byte, bool) {
	switch {
	case b >= '0' && b <= '9':
		return b - '0', true
	case b >= 'a' && b <= 'f':
		return b - 'a' + 10, true
	case b >= 'A' && b <= 'F':
		return b - 'A' + 10, true
	}
	return 0, false
}
