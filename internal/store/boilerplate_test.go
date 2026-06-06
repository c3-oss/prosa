package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

func TestListSessionsWithBoilerplatePromptCoversAllPrefixes(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "store.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	now := time.Now().UTC()

	seed := func(id, prompt string) {
		p := prompt
		require.NoError(t, s.UpsertSession(ctx, session.Session{
			ID:             id,
			Agent:          "test",
			DeviceID:       "local",
			FirstPrompt:    &p,
			StartedAt:      now,
			LastActivityAt: now,
			RawPath:        "/dev/null",
			RawHash:        "h-" + id,
		}, nil))
	}

	// Each prefix from sessiontext.Prefixes must trigger a hit.
	seed("a", "<command-name>/init</command-name>")
	seed("b", "<local-command-caveat>auto</local-command-caveat>\nactually meta")
	seed("c", "You are Codex, a coding agent. Knowledge cutoff: 2025.")
	seed("d", "# AGENTS.md instructions for /tmp")
	seed("real", "deploy the staging branch")

	got, err := s.ListSessionsWithBoilerplatePrompt(ctx, 0)
	require.NoError(t, err)
	ids := map[string]struct{}{}
	for _, g := range got {
		ids[g.ID] = struct{}{}
	}
	require.Contains(t, ids, "a")
	require.Contains(t, ids, "b")
	require.Contains(t, ids, "c")
	require.Contains(t, ids, "d")
	require.NotContains(t, ids, "real")
}

func TestListSessionsWithBoilerplatePromptLimitRespected(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "store.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	now := time.Now().UTC()

	for i, prefix := range []string{
		"<command-name>x</command-name>",
		"<system-reminder>y</system-reminder>",
		"<INSTRUCTIONS>z</INSTRUCTIONS>",
	} {
		p := prefix
		require.NoError(t, s.UpsertSession(ctx, session.Session{
			ID:             "s-" + string(rune('0'+i)),
			Agent:          "test",
			DeviceID:       "local",
			FirstPrompt:    &p,
			StartedAt:      now,
			LastActivityAt: now,
			RawPath:        "/dev/null",
			RawHash:        "h",
		}, nil))
	}
	got, err := s.ListSessionsWithBoilerplatePrompt(ctx, 2)
	require.NoError(t, err)
	require.Len(t, got, 2)
}
