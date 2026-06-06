package cli

import (
	"io"
	"testing"

	"github.com/stretchr/testify/require"
)

// --all disables the cwd project auto-filter, so pairing it with --project
// is contradictory; the combination must be rejected at parse time rather
// than silently letting one win. See issue #89.
func TestValidateGlobalsAllProjectExclusive(t *testing.T) {
	originalFlags := g
	t.Cleanup(func() { g = originalFlags })

	both := newRootCmd()
	require.NoError(t, both.ParseFlags([]string{"--all", "--project", "foo"}))
	require.ErrorContains(t, validateGlobals(both), "--all and --project are mutually exclusive")

	allOnly := newRootCmd()
	require.NoError(t, allOnly.ParseFlags([]string{"--all"}))
	require.NoError(t, validateGlobals(allOnly))

	projectOnly := newRootCmd()
	require.NoError(t, projectOnly.ParseFlags([]string{"--project", "foo"}))
	require.NoError(t, validateGlobals(projectOnly))

	neither := newRootCmd()
	require.NoError(t, neither.ParseFlags(nil))
	require.NoError(t, validateGlobals(neither))
}

func TestValidateGlobalsAgentKnown(t *testing.T) {
	originalFlags := g
	t.Cleanup(func() { g = originalFlags })

	valid := newRootCmd()
	require.NoError(t, valid.ParseFlags([]string{"--agent", "codex"}))
	require.NoError(t, validateGlobals(valid))

	invalid := newRootCmd()
	require.NoError(t, invalid.ParseFlags([]string{"--agent", "banana"}))
	require.ErrorContains(t, validateGlobals(invalid), `--agent: unknown agent "banana"; expected one of (claude-code, codex, cursor, gemini, antigravity, hermes)`)
}

// The combination is rejected through the command's PersistentPreRunE, so
// it fails before any sub-command body runs (no store access required).
func TestRootRejectsAllAndProjectEndToEnd(t *testing.T) {
	originalFlags := g
	t.Cleanup(func() { g = originalFlags })

	cmd := newRootCmd()
	cmd.SetArgs([]string{"--all", "--project", "foo"})
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)

	err := cmd.Execute()
	require.ErrorContains(t, err, "--all and --project are mutually exclusive")
}

// Unknown agents are rejected by the global pre-run before command bodies open
// the store, preventing typos from masquerading as empty result sets.
func TestRootRejectsUnknownAgentEndToEnd(t *testing.T) {
	originalFlags := g
	t.Cleanup(func() { g = originalFlags })

	cmd := newRootCmd()
	cmd.SetArgs([]string{"--agent", "banana"})
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)

	err := cmd.Execute()
	require.ErrorContains(t, err, `--agent: unknown agent "banana"; expected one of (claude-code, codex, cursor, gemini, antigravity, hermes)`)
}
