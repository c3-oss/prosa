package cli

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
	"github.com/stretchr/testify/require"
)

func TestNoColorFlagIsRegistered(t *testing.T) {
	cmd := newRootCmd()
	flag := cmd.PersistentFlags().Lookup("no-color")

	require.NotNil(t, flag)
	require.Equal(t, "false", flag.DefValue)
}

func TestApplyGlobalFlagsNoColorSuppressesLipglossANSI(t *testing.T) {
	originalProfile := lipgloss.ColorProfile()
	originalFlags := g
	t.Cleanup(func() {
		lipgloss.SetColorProfile(originalProfile)
		g = originalFlags
	})

	g.NoColor = true
	applyGlobalFlags()

	require.Equal(t, termenv.Ascii, lipgloss.ColorProfile())
	out := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#D6B97A")).Render("plain")
	require.Equal(t, "plain", out)
	require.False(t, strings.Contains(out, "\x1b["), "no-color output must not contain ANSI styling")
}
