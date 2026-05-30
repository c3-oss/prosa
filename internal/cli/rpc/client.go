// Package rpc loads the saved auth.json and constructs Connect clients
// that automatically attach the Bearer token. Every CLI command that
// talks to prosa-server goes through here.
package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"connectrpc.com/connect"

	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/paths"
)

// AuthFile is the on-disk shape of ~/.config/prosa/auth.json.
type AuthFile struct {
	Server   string `json:"server"`
	DeviceID string `json:"device_id"`
	Token    string `json:"token"`
}

// LoadAuth reads the saved auth file. Returns os.ErrNotExist when the
// file is missing — callers can treat that as "not logged in".
func LoadAuth() (AuthFile, error) {
	path, err := paths.AuthPath()
	if err != nil {
		return AuthFile{}, err
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return AuthFile{}, err
	}
	var f AuthFile
	if err := json.Unmarshal(body, &f); err != nil {
		return AuthFile{}, fmt.Errorf("parse %s: %w", path, err)
	}
	if f.Server == "" || f.Token == "" {
		return AuthFile{}, errors.New("auth file present but incomplete")
	}
	return f, nil
}

// SaveAuth atomically writes the file with 0600 permissions.
func SaveAuth(f AuthFile) error {
	dir, err := paths.ConfigHome()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	body, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	final := filepath.Join(dir, "auth.json")
	tmp := final + ".tmp"
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, final)
}

// DeleteAuth removes auth.json. No-op when the file doesn't exist.
func DeleteAuth() error {
	path, err := paths.AuthPath()
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// bearerTransport wraps the round-tripper so every request grows an
// Authorization header. nil token is allowed for the public RPCs
// (Auth.StartLogin/PollLogin) — the server still accepts them.
type bearerTransport struct {
	base  http.RoundTripper
	token string
}

func (t *bearerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if t.token != "" {
		req.Header.Set("Authorization", "Bearer "+t.token)
	}
	return t.base.RoundTrip(req)
}

// httpClient returns the http.Client used by every service client.
func httpClient(token string) *http.Client {
	return &http.Client{Transport: &bearerTransport{base: http.DefaultTransport, token: token}}
}

// NormalizeServerURL turns ":7070" into "http://localhost:7070" and
// strips trailing slashes.
func NormalizeServerURL(in string) string {
	if !strings.HasPrefix(in, "http://") && !strings.HasPrefix(in, "https://") {
		host := strings.TrimPrefix(in, ":")
		in = "http://localhost:" + host
	}
	return strings.TrimRight(in, "/")
}

// Auth returns an AuthServiceClient (no auth file required; the auth
// RPCs are public).
func Auth(server string) prosav1connect.AuthServiceClient {
	return prosav1connect.NewAuthServiceClient(httpClient(""), NormalizeServerURL(server))
}

// Sessions / Devices clients pull token from the loaded auth file. If
// the file is missing the caller gets an error so the command can
// suggest `prosa login`.
func Sessions(server, token string) prosav1connect.SessionsServiceClient {
	return prosav1connect.NewSessionsServiceClient(httpClient(token), NormalizeServerURL(server))
}

func Analytics(server, token string) prosav1connect.AnalyticsServiceClient {
	return prosav1connect.NewAnalyticsServiceClient(httpClient(token), NormalizeServerURL(server))
}

func Devices(server, token string) prosav1connect.DevicesServiceClient {
	return prosav1connect.NewDevicesServiceClient(httpClient(token), NormalizeServerURL(server))
}

// ConnectError unwraps connect.Error for display.
func ConnectError(err error) string {
	if err == nil {
		return ""
	}
	var ce *connect.Error
	if errors.As(err, &ce) {
		return ce.Message()
	}
	return err.Error()
}

// ContextOrBackground returns ctx when not nil, else a fresh background ctx.
func ContextOrBackground(ctx context.Context) context.Context {
	if ctx == nil {
		return context.Background()
	}
	return ctx
}
