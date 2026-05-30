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

func newAnalyticsStore(t *testing.T) (context.Context, *store.Store, time.Time) {
	t.Helper()
	ctx := context.Background()
	s, err := store.Open(ctx, filepath.Join(t.TempDir(), "store.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	now := time.Now().UTC()

	mk := func(id, agent, project, model string, dAgo time.Duration) {
		p := project
		m := model
		require.NoError(t, s.UpsertSession(ctx, session.Session{
			ID:             id,
			Agent:          agent,
			DeviceID:       "local",
			ProjectPath:    &p,
			Model:          &m,
			StartedAt:      now.Add(-dAgo),
			LastActivityAt: now.Add(-dAgo + time.Minute),
			RawPath:        "/tmp/" + id + ".jsonl",
			RawHash:        "h-" + id,
			RawSize:        100,
		}, []session.ToolUsage{
			{Name: "Read", Count: 5},
			{Name: "Bash", Count: 2},
		}))
		require.NoError(t, s.InsertTurns(ctx, id, []session.Turn{
			{Role: "user", Content: "hello", Timestamp: now.Add(-dAgo)},
			{Role: "assistant", Content: "world", Timestamp: now.Add(-dAgo + 30*time.Second)},
		}))
	}
	mk("a", "claude-code", "/u/proj-alpha", "claude-sonnet", 1*time.Hour)
	mk("b", "claude-code", "/u/proj-beta", "claude-sonnet", 2*time.Hour)
	mk("c", "codex", "/u/proj-alpha", "gpt-5-codex", 3*time.Hour)

	// Session 'd' has an error-flavored assistant turn so AnalyticsErrors hits.
	mk("d", "codex", "/u/proj-gamma", "gpt-5-codex", 4*time.Hour)
	require.NoError(t, s.InsertTurns(ctx, "d", []session.Turn{
		{Role: "user", Content: "build it", Timestamp: now.Add(-4 * time.Hour)},
		{Role: "assistant", Content: "TypeError: nope; full traceback follows", Timestamp: now.Add(-4 * time.Hour)},
	}))
	return ctx, s, now
}

func filter(now time.Time) store.SessionFilter {
	return store.SessionFilter{
		Since: now.Add(-24 * time.Hour),
		Until: now,
	}
}

func TestAnalyticsSessions(t *testing.T) {
	ctx, s, now := newAnalyticsStore(t)
	r, err := s.AnalyticsSessions(ctx, filter(now))
	require.NoError(t, err)
	require.Equal(t, []string{"AGENT", "SESSIONS", "TURNS"}, r.Headers)
	require.GreaterOrEqual(t, len(r.Rows), 2)
}

func TestAnalyticsTools(t *testing.T) {
	ctx, s, now := newAnalyticsStore(t)
	r, err := s.AnalyticsTools(ctx, filter(now))
	require.NoError(t, err)
	require.Equal(t, []string{"TOOL", "USES", "SESSIONS"}, r.Headers)
	// Read appears more than Bash; it should be first.
	require.NotEmpty(t, r.Rows)
	require.Equal(t, "Read", r.Rows[0].Values[0])
}

func TestAnalyticsModels(t *testing.T) {
	ctx, s, now := newAnalyticsStore(t)
	r, err := s.AnalyticsModels(ctx, filter(now))
	require.NoError(t, err)
	require.Equal(t, []string{"MODEL", "SESSIONS"}, r.Headers)
	require.GreaterOrEqual(t, len(r.Rows), 2)
}

func TestAnalyticsProjects(t *testing.T) {
	ctx, s, now := newAnalyticsStore(t)
	r, err := s.AnalyticsProjects(ctx, filter(now))
	require.NoError(t, err)
	require.Equal(t, []string{"PROJECT", "AGENT", "SESSIONS"}, r.Headers)
	require.NotEmpty(t, r.Rows)
}

func TestAnalyticsErrors(t *testing.T) {
	ctx, s, now := newAnalyticsStore(t)
	r, err := s.AnalyticsErrors(ctx, filter(now))
	require.NoError(t, err)
	require.Equal(t, []string{"STARTED", "AGENT", "PROJECT", "SESSION"}, r.Headers)
	// Session 'd' has the trigger words; should land in the result.
	var ids []string
	for _, row := range r.Rows {
		ids = append(ids, row.Values[3].(string))
	}
	require.Contains(t, ids, "d")
}
