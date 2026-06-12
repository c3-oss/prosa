package store

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

func openAnalyticsTestStore(t *testing.T) (context.Context, *Store) {
	t.Helper()
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "store.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	return ctx, s
}

// wideAnalyticsFilter spans the whole seed window so the time bounds never
// drop a row — the tests assert on the grouping, not the window.
func wideAnalyticsFilter() SessionFilter {
	return SessionFilter{
		Since: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		Until: time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC),
	}
}

func seedAnalyticsSession(t *testing.T, ctx context.Context, s *Store, id, model string, started time.Time, usage *session.TokenUsage, turns []session.Turn) {
	t.Helper()
	m := model
	require.NoError(t, s.UpsertSession(ctx, session.Session{
		ID:             id,
		Agent:          "claude-code",
		DeviceID:       "local",
		Model:          &m,
		StartedAt:      started,
		LastActivityAt: started.Add(time.Minute),
		RawPath:        "/tmp/" + id + ".jsonl",
		RawHash:        "h-" + id,
	}, nil))
	if usage != nil {
		// UpsertSession persists usage only when set on the session; re-upsert
		// with the usage attached keeps the helper's signature explicit.
		require.NoError(t, s.UpsertSession(ctx, session.Session{
			ID:             id,
			Agent:          "claude-code",
			DeviceID:       "local",
			Model:          &m,
			StartedAt:      started,
			LastActivityAt: started.Add(time.Minute),
			RawPath:        "/tmp/" + id + ".jsonl",
			RawHash:        "h-" + id,
			Usage:          usage,
		}, nil))
	}
	if len(turns) > 0 {
		require.NoError(t, s.InsertTurns(ctx, id, turns))
	}
}

func TestAnalyticsSubagents(t *testing.T) {
	t.Parallel()
	ctx, s := openAnalyticsTestStore(t)
	started := time.Date(2026, 1, 5, 10, 0, 0, 0, time.UTC)
	seed := func(id, agent, profile string, at time.Time, parent *string) {
		t.Helper()
		require.NoError(t, s.UpsertSession(ctx, session.Session{
			ID:              id,
			Agent:           agent,
			DeviceID:        "local",
			Profile:         profile,
			StartedAt:       at,
			LastActivityAt:  at.Add(time.Minute),
			RawPath:         "/tmp/" + id + ".jsonl",
			RawHash:         "h-" + id,
			ParentSessionID: parent,
		}, nil))
	}
	p1, p2 := "p1", "p2"
	seed("p1", "claude-code", "default", started, nil)
	seed("c1", "claude-code", "default", started.Add(5*time.Minute), &p1)
	seed("c2", "claude-code", "work", started.Add(10*time.Minute), &p1)
	seed("p2", "codex", "default", started.Add(time.Hour), nil)
	seed("c3", "codex", "default", started.Add(time.Hour+5*time.Minute), &p2)
	// Outside the window: must not count toward p1's fan-out.
	seed("c4", "claude-code", "default", time.Date(2026, 2, 5, 10, 0, 0, 0, time.UTC), &p1)

	r, err := s.AnalyticsSubagents(ctx, wideAnalyticsFilter())
	require.NoError(t, err)
	require.Equal(t, []string{"AGENT", "PARENTS", "CHILDREN", "MAX_FANOUT"}, r.Headers)
	require.Len(t, r.Rows, 2)
	require.Equal(t, []any{"claude-code", "1", "2", "2"}, r.Rows[0].Values)
	require.Equal(t, []any{"codex", "1", "1", "1"}, r.Rows[1].Values)

	// The profile filter applies to the children, not the parents.
	work := "work"
	f := wideAnalyticsFilter()
	f.Profile = &work
	r, err = s.AnalyticsSubagents(ctx, f)
	require.NoError(t, err)
	require.Len(t, r.Rows, 1)
	require.Equal(t, []any{"claude-code", "1", "1", "1"}, r.Rows[0].Values)
}

func TestAnalyticsHours(t *testing.T) {
	t.Parallel()
	ctx, s := openAnalyticsTestStore(t)
	at := func(h int) time.Time { return time.Date(2026, 1, 5, h, 30, 0, 0, time.UTC) }
	seedAnalyticsSession(t, ctx, s, "h1", "claude-opus-4-5", at(9), nil, nil)
	seedAnalyticsSession(t, ctx, s, "h2", "claude-opus-4-5", at(9), nil, nil)
	seedAnalyticsSession(t, ctx, s, "h3", "claude-opus-4-5", at(14), nil, nil)

	r, err := s.AnalyticsHours(ctx, wideAnalyticsFilter())
	require.NoError(t, err)
	require.Equal(t, []string{"HOUR", "SESSIONS"}, r.Headers)

	got := map[string]string{}
	for _, row := range r.Rows {
		got[row.Values[0].(string)] = row.Values[1].(string)
	}
	require.Equal(t, "2", got["09"])
	require.Equal(t, "1", got["14"])
}

func TestAnalyticsProjectsIsNotCappedBeforePanelRollup(t *testing.T) {
	t.Parallel()
	ctx, s := openAnalyticsTestStore(t)
	started := time.Date(2026, 1, 5, 10, 0, 0, 0, time.UTC)
	for i := 0; i < 31; i++ {
		project := fmt.Sprintf("/tmp/proj-%02d", i)
		model := "claude-sonnet-4-6"
		require.NoError(t, s.UpsertSession(ctx, session.Session{
			ID:             fmt.Sprintf("p-%02d", i),
			Agent:          "claude-code",
			DeviceID:       "local",
			ProjectPath:    &project,
			Model:          &model,
			StartedAt:      started.Add(time.Duration(i) * time.Minute),
			LastActivityAt: started.Add(time.Duration(i)*time.Minute + time.Second),
			RawPath:        fmt.Sprintf("/tmp/p-%02d.jsonl", i),
			RawHash:        fmt.Sprintf("hp-%02d", i),
		}, nil))
	}

	r, err := s.AnalyticsProjects(ctx, wideAnalyticsFilter())
	require.NoError(t, err)
	require.Equal(t, []string{"PROJECT", "AGENT", "SESSIONS"}, r.Headers)
	require.Len(t, r.Rows, 31)
}

func TestAnalyticsErrorsByModel(t *testing.T) {
	t.Parallel()
	ctx, s := openAnalyticsTestStore(t)
	at := time.Date(2026, 1, 5, 10, 0, 0, 0, time.UTC)
	mkTurns := func(text string) []session.Turn {
		return []session.Turn{
			{Role: "user", Content: "do it", Timestamp: at},
			{Role: "assistant", Content: text, Timestamp: at},
		}
	}
	seedAnalyticsSession(t, ctx, s, "e1", "claude-sonnet-4-6", at, nil, mkTurns("panic: boom"))
	seedAnalyticsSession(t, ctx, s, "e2", "claude-sonnet-4-6", at, nil, mkTurns("fatal error follows"))
	seedAnalyticsSession(t, ctx, s, "e3", "gpt-5-codex", at, nil, mkTurns("an exception was thrown"))
	seedAnalyticsSession(t, ctx, s, "e4", "claude-sonnet-4-6", at, nil, mkTurns("all good, shipped clean"))

	r, err := s.AnalyticsErrorsByModel(ctx, wideAnalyticsFilter())
	require.NoError(t, err)
	require.Equal(t, []string{"MODEL", "SESSIONS"}, r.Headers)

	got := map[string]string{}
	for _, row := range r.Rows {
		got[row.Values[0].(string)] = row.Values[1].(string)
	}
	require.Equal(t, "2", got["claude-sonnet-4-6"])
	require.Equal(t, "1", got["gpt-5-codex"])
}

func TestAnalyticsUsageByModel(t *testing.T) {
	t.Parallel()
	ctx, s := openAnalyticsTestStore(t)
	at := time.Date(2026, 1, 5, 10, 0, 0, 0, time.UTC)
	seedAnalyticsSession(t, ctx, s, "u1", "claude-opus-4-5", at,
		&session.TokenUsage{TotalTokens: 1000, InputTokens: 800, OutputTokens: 200}, nil)
	seedAnalyticsSession(t, ctx, s, "u2", "claude-opus-4-5", at,
		&session.TokenUsage{TotalTokens: 500, InputTokens: 400, OutputTokens: 100}, nil)
	seedAnalyticsSession(t, ctx, s, "u3", "claude-sonnet-4-6", at,
		&session.TokenUsage{TotalTokens: 300, InputTokens: 200, OutputTokens: 100}, nil)

	r, err := s.AnalyticsUsageByModel(ctx, wideAnalyticsFilter())
	require.NoError(t, err)
	require.Equal(t, []string{"MODEL", "SESSIONS", "TOTAL", "INPUT", "OUTPUT", "EST_COST_USD"}, r.Headers)

	byModel := map[string][]any{}
	for _, row := range r.Rows {
		byModel[row.Values[0].(string)] = row.Values
	}
	opus := byModel["claude-opus-4-5"]
	require.NotNil(t, opus)
	require.Equal(t, "2", opus[1])    // sessions
	require.Equal(t, "1500", opus[2]) // total tokens
	require.Equal(t, "1200", opus[3]) // input
	require.Equal(t, "300", opus[4])  // output
	require.NotEmpty(t, opus[5])      // est cost — claude-opus-4-5 is priced
}
