package cli

import (
	"bytes"
	"io"
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

func TestParentCommandsRequireExplicitSubcommands(t *testing.T) {
	originalFlags := g
	t.Cleanup(func() { g = originalFlags })

	for _, tc := range []struct {
		name        string
		args        []string
		wantUsage   string
		wantCommand string
	}{
		{
			name:        "devices",
			args:        []string{"devices"},
			wantUsage:   "Usage:\n  prosa devices [command]",
			wantCommand: "list",
		},
		{
			name:        "schedule",
			args:        []string{"schedule"},
			wantUsage:   "Usage:\n  prosa schedule [command]",
			wantCommand: "status",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			cmd := newRootCmd()
			cmd.SetArgs(tc.args)
			cmd.SetOut(&out)
			cmd.SetErr(io.Discard)

			require.NoError(t, cmd.Execute())
			require.Contains(t, out.String(), tc.wantUsage)
			require.Contains(t, out.String(), tc.wantCommand)
			require.NotContains(t, out.String(), "not logged in")
		})
	}
}

func TestCompletionRejectsUnknownShell(t *testing.T) {
	originalFlags := g
	t.Cleanup(func() { g = originalFlags })

	cmd := newRootCmd()
	cmd.SetArgs([]string{"completion", "wat"})
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)

	require.ErrorContains(t, cmd.Execute(), `invalid argument "wat"`)
}

func TestCompletionWithoutShellShowsHelp(t *testing.T) {
	originalFlags := g
	t.Cleanup(func() { g = originalFlags })

	var out bytes.Buffer
	cmd := newRootCmd()
	cmd.SetArgs([]string{"completion"})
	cmd.SetOut(&out)
	cmd.SetErr(io.Discard)

	require.NoError(t, cmd.Execute())
	require.Contains(t, out.String(), "Generate the autocompletion script")
	require.Contains(t, out.String(), "bash")
}
