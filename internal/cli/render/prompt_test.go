package render

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCleanFirstPromptKeepsRealPrompt(t *testing.T) {
	in := "refactor the sync logic so the reconcile is idempotent"
	out, ok := CleanFirstPrompt(in)
	require.True(t, ok)
	require.Equal(t, in, out)
}

func TestCleanFirstPromptFlagsBoilerplate(t *testing.T) {
	cases := []string{
		"# AGENTS.md instructions for /Users/me/Projects/foo",
		"<command-name>/model</command-name> <command-message>model</command-message>",
		"<command-args>--flag</command-args>",
		"<system-reminder>This is automated.</system-reminder>",
		"<INSTRUCTIONS> # Global instructions",
		// Leading whitespace shouldn't fool us.
		"   # AGENTS.md instructions for /tmp",
		"\n\t<command-name>/init</command-name>",
	}
	for _, in := range cases {
		t.Run(in[:min(30, len(in))], func(t *testing.T) {
			_, ok := CleanFirstPrompt(in)
			require.False(t, ok, "expected %q to be flagged as boilerplate", in)
		})
	}
}

func TestRenderFirstPromptMutedForBoilerplate(t *testing.T) {
	out := RenderFirstPrompt("# AGENTS.md instructions for /tmp/x")
	// The output is styled, but the underlying token must be present.
	require.True(t, strings.Contains(out, MetaPlaceholder),
		"expected MetaPlaceholder in styled output, got %q", out)
}

func TestRenderFirstPromptPassesThroughRealContent(t *testing.T) {
	out := RenderFirstPrompt("explain quantum entanglement")
	require.Equal(t, "explain quantum entanglement", out)
}
