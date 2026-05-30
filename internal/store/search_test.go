package store

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

func seedSearchStore(t *testing.T) (context.Context, *Store, time.Time) {
	t.Helper()
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "store.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	now := time.Now().UTC()

	mk := func(id, agent, project string, ago time.Duration) {
		p := project
		sess := session.Session{
			ID:             id,
			Agent:          agent,
			DeviceID:       "local",
			ProjectPath:    &p,
			StartedAt:      now.Add(-ago),
			LastActivityAt: now.Add(-ago + time.Minute),
			RawPath:        "/tmp/" + id + ".jsonl",
			RawHash:        "h-" + id,
			RawSize:        100,
		}
		require.NoError(t, s.UpsertSession(ctx, sess, nil))
	}

	mk("a", "claude-code", "/u/proj-alpha", time.Hour)
	mk("b", "claude-code", "/u/proj-beta", 2*time.Hour)
	mk("c", "codex", "/u/proj-alpha", 30*time.Minute)

	put := func(sid, role, content string, atAgo time.Duration) {
		require.NoError(t, s.InsertTurns(ctx, sid, []session.Turn{{
			Role: role, Content: content, Timestamp: now.Add(-atAgo),
		}}))
	}

	put("a", "user", "explain quantum entanglement in plain terms", time.Hour)
	put("b", "user", "deploy the terraform module to production", 2*time.Hour)
	put("c", "assistant", "quantum mechanics describes particle behavior", 30*time.Minute)
	return ctx, s, now
}

func TestSearchSingleTerm(t *testing.T) {
	ctx, s, now := seedSearchStore(t)
	hits, err := s.Search(ctx, "quantum", SessionFilter{
		Since: now.Add(-24 * time.Hour), Until: now,
	}, 10)
	require.NoError(t, err)
	require.Len(t, hits, 2)
	for _, h := range hits {
		require.Contains(t, h.Snippet, SnippetMarkStart)
		require.Contains(t, h.Snippet, SnippetMarkEnd)
	}
}

func TestSearchNoMatches(t *testing.T) {
	ctx, s, now := seedSearchStore(t)
	hits, err := s.Search(ctx, "zzznotpresent", SessionFilter{
		Since: now.Add(-24 * time.Hour), Until: now,
	}, 10)
	require.NoError(t, err)
	require.Empty(t, hits)
}

func TestSearchFilterByAgent(t *testing.T) {
	ctx, s, now := seedSearchStore(t)
	hits, err := s.Search(ctx, "quantum", SessionFilter{
		Since: now.Add(-24 * time.Hour), Until: now,
		Agent: ptrStr("codex"),
	}, 10)
	require.NoError(t, err)
	require.Len(t, hits, 1)
	require.Equal(t, "c", hits[0].Session.ID)
	require.Equal(t, "assistant", hits[0].Role)
}

func TestSearchFilterByProjectExact(t *testing.T) {
	ctx, s, now := seedSearchStore(t)
	hits, err := s.Search(ctx, "terraform", SessionFilter{
		Since: now.Add(-24 * time.Hour), Until: now,
		ProjectExact: ptrStr("/u/proj-beta"),
	}, 10)
	require.NoError(t, err)
	require.Len(t, hits, 1)
	require.Equal(t, "b", hits[0].Session.ID)
}

func TestSearchOnePerSession(t *testing.T) {
	ctx, s, now := seedSearchStore(t)
	// Add a second matching turn into session "a" so we can prove the
	// CTE row_number dedup keeps only one row per session.
	require.NoError(t, s.InsertTurns(ctx, "a", []session.Turn{
		{Role: "user", Content: "explain quantum entanglement in plain terms", Timestamp: now.Add(-time.Hour)},
		{Role: "assistant", Content: "quantum is the unit of light energy", Timestamp: now.Add(-time.Hour + time.Minute)},
	}))
	hits, err := s.Search(ctx, "quantum", SessionFilter{
		Since: now.Add(-24 * time.Hour), Until: now,
	}, 10)
	require.NoError(t, err)
	ids := map[string]int{}
	for _, h := range hits {
		ids[h.Session.ID]++
	}
	for id, n := range ids {
		require.Equal(t, 1, n, "session %s should appear once, got %d", id, n)
	}
}

func TestSearchLimit(t *testing.T) {
	ctx, s, now := seedSearchStore(t)
	hits, err := s.Search(ctx, "quantum", SessionFilter{
		Since: now.Add(-24 * time.Hour), Until: now,
	}, 1)
	require.NoError(t, err)
	require.Len(t, hits, 1)
}

func TestSearchEmptyQuery(t *testing.T) {
	ctx, s, now := seedSearchStore(t)
	_, err := s.Search(ctx, "   ", SessionFilter{
		Since: now.Add(-24 * time.Hour), Until: now,
	}, 10)
	require.Error(t, err)
}

func TestSearchSnippetContainsMatch(t *testing.T) {
	ctx, s, now := seedSearchStore(t)
	hits, err := s.Search(ctx, "terraform", SessionFilter{
		Since: now.Add(-24 * time.Hour), Until: now,
	}, 10)
	require.NoError(t, err)
	require.Len(t, hits, 1)
	require.True(t,
		strings.Contains(hits[0].Snippet, SnippetMarkStart+"terraform"+SnippetMarkEnd),
		"snippet should wrap the matched term: got %q", hits[0].Snippet,
	)
}
