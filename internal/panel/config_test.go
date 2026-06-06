package panel

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// dev-login hands out an owner session with no authentication, so Load
// must refuse to start when it's combined with secure cookies — the signal
// of a production (TLS) deploy where an env-var slip would expose an auth
// bypass to the internet. See issue #126.
func TestLoadRefusesDevLoginWithSecureCookies(t *testing.T) {
	t.Setenv("PROSA_ADMIN_TOKEN", "admin")
	t.Setenv("PROSA_PANEL_COOKIE_KEY", "placeholder-not-a-real-key")
	t.Setenv("PROSA_OWNER_EMAILS", "owner@example.com")
	t.Setenv("PROSA_PANEL_DEV_LOGIN", "owner@example.com")

	t.Setenv("PROSA_PANEL_COOKIE_SECURE", "true")
	_, err := Load()
	require.Error(t, err)
	require.Contains(t, err.Error(), "PROSA_PANEL_DEV_LOGIN")

	t.Setenv("PROSA_PANEL_COOKIE_SECURE", "false")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, "owner@example.com", cfg.DevLoginEmail)
}
