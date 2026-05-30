package cli

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/internal/store"
	"github.com/c3-oss/prosa/pkg/session"
)

func seedProjects(t *testing.T, paths ...string) *store.Store {
	t.Helper()
	ctx := context.Background()
	s, err := store.Open(ctx, filepath.Join(t.TempDir(), "store.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })

	now := time.Now().UTC()
	for i, p := range paths {
		project := p
		require.NoError(t, s.UpsertSession(ctx, session.Session{
			ID:             "proj-test-" + filepath.Base(p) + "-" + filepath.Base(p) + "-" + string(rune('a'+i)),
			Agent:          "claude-code",
			DeviceID:       "local",
			ProjectPath:    &project,
			StartedAt:      now.Add(-time.Hour),
			LastActivityAt: now.Add(-30 * time.Minute),
			RawPath:        "/tmp/raw/" + filepath.Base(p) + ".jsonl",
			RawHash:        "h-" + filepath.Base(p),
			RawSize:        100,
		}, nil))
	}
	return s
}

func TestDetectProjectExactMatch(t *testing.T) {
	s := seedProjects(t, "/Users/u/foo", "/Users/u/bar")
	m, err := DetectProject(context.Background(), "/Users/u/foo", s)
	require.NoError(t, err)
	require.True(t, m.Found)
	require.Equal(t, "/Users/u/foo", m.Path)
}

func TestDetectProjectAncestorMatch(t *testing.T) {
	s := seedProjects(t, "/Users/u/foo")
	m, err := DetectProject(context.Background(), "/Users/u/foo/sub/deeper", s)
	require.NoError(t, err)
	require.True(t, m.Found)
	require.Equal(t, "/Users/u/foo", m.Path)
}

func TestDetectProjectLongestWins(t *testing.T) {
	s := seedProjects(t, "/Users/u/foo", "/Users/u/foo/bar")
	m, err := DetectProject(context.Background(), "/Users/u/foo/bar/sub", s)
	require.NoError(t, err)
	require.True(t, m.Found)
	require.Equal(t, "/Users/u/foo/bar", m.Path, "the deeper project root should win over the ancestor")
}

func TestDetectProjectDisjoint(t *testing.T) {
	s := seedProjects(t, "/Users/u/foo")
	m, err := DetectProject(context.Background(), "/Users/u/elsewhere", s)
	require.NoError(t, err)
	require.False(t, m.Found)
}

func TestDetectProjectSiblingNoMatch(t *testing.T) {
	// /Users/u/foobar should NOT match /Users/u/foo via prefix.
	s := seedProjects(t, "/Users/u/foo")
	m, err := DetectProject(context.Background(), "/Users/u/foobar", s)
	require.NoError(t, err)
	require.False(t, m.Found, "prefix HasPrefix without separator would falsely match /Users/u/foobar against /Users/u/foo")
}
