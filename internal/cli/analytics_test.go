package cli

import (
	"context"
	"path/filepath"
	"strconv"
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
		var usage *session.TokenUsage
		switch id {
		case "a":
			usage = &session.TokenUsage{
				TotalTokens:         1250,
				InputTokens:         1100,
				OutputTokens:        100,
				CachedTokens:        100,
				CacheReadTokens:     100,
				CacheCreationTokens: 50,
			}
		case "c":
			usage = &session.TokenUsage{
				TotalTokens:     2500,
				InputTokens:     2000,
				OutputTokens:    500,
				CachedTokens:    400,
				CacheReadTokens: 400,
			}
		case "d":
			usage = &session.TokenUsage{
				TotalTokens:     1100,
				InputTokens:     1000,
				OutputTokens:    100,
				CachedTokens:    100,
				CacheReadTokens: 100,
			}
		}
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
			Usage:          usage,
		}, []session.ToolUsage{
			{Name: "Read", Count: 5},
			{Name: "Bash", Count: 2},
		}))
		require.NoError(t, s.InsertTurns(ctx, id, []session.Turn{
			{Role: "user", Content: "hello", Timestamp: now.Add(-dAgo)},
			{Role: "assistant", Content: "world", Timestamp: now.Add(-dAgo + 30*time.Second)},
		}))
	}
	mk("a", "claude-code", "/u/proj-alpha", "claude-sonnet-4-6", 1*time.Hour)
	mk("b", "claude-code", "/u/proj-beta", "claude-sonnet-4-6", 2*time.Hour)
	mk("c", "codex", "/u/proj-alpha", "gpt-5-codex", 3*time.Hour)

	// Session 'd' has an error-flavored assistant turn so AnalyticsErrors hits.
	mk("d", "codex", "/u/proj-gamma", "gpt-5-codex", 4*time.Hour)
	require.NoError(t, s.InsertTurns(ctx, "d", []session.Turn{
		{Role: "user", Content: "build it", Timestamp: now.Add(-4 * time.Hour)},
		{Role: "assistant", Content: "TypeError: nope; full traceback follows", Timestamp: now.Add(-4 * time.Hour)},
	}))
	return ctx, s, now
}

func TestAnalyticsHeatmap(t *testing.T) {
	ctx, s, now := newAnalyticsStore(t)
	r, err := s.AnalyticsHeatmap(ctx, filter(now))
	require.NoError(t, err)
	// The local store now emits the canonical per-(day, agent) shape,
	// matching the server (issue #73).
	require.Equal(t, []string{"DATE", "AGENT", "SESSIONS"}, r.Headers)
	require.NotEmpty(t, r.Rows)

	var total int
	for _, row := range r.Rows {
		n, err := strconv.Atoi(row.Values[2].(string))
		require.NoError(t, err)
		total += n
	}
	require.Equal(t, 4, total)

	rolled := rollupHeatmapForDisplay("heatmap", r)
	require.Equal(t, []string{"DATE", "SESSIONS"}, rolled.Headers)
	var rolledTotal int
	for _, row := range rolled.Rows {
		n, err := strconv.Atoi(row.Values[1].(string))
		require.NoError(t, err)
		rolledTotal += n
	}
	require.Equal(t, 4, rolledTotal)
}

func TestRollupHeatmapForDisplay_FoldsAgentRows(t *testing.T) {
	result := rollupHeatmapForDisplay("heatmap", store.AnalyticsResult{
		Headers: []string{"DATE", "AGENT", "SESSIONS"},
		Rows: []store.AnalyticsRow{
			{Values: []any{"2026-05-22", "claude-code", "4"}},
			{Values: []any{"2026-05-22", "codex", "5"}},
			{Values: []any{"2026-05-23", "", "0"}},
		},
	})

	require.Equal(t, []string{"DATE", "SESSIONS"}, result.Headers)
	require.Equal(t, []store.AnalyticsRow{
		{Values: []any{"2026-05-22", "9"}},
		{Values: []any{"2026-05-23", "0"}},
	}, result.Rows)
}

func TestRollupHeatmapForDisplay_LeavesNonCanonicalShape(t *testing.T) {
	original := store.AnalyticsResult{
		Headers: []string{"DATE", "SESSIONS"},
		Rows: []store.AnalyticsRow{
			{Values: []any{"2026-05-22", "9"}},
		},
	}

	require.Equal(t, original, rollupHeatmapForDisplay("heatmap", original))
}

func TestAnalyticsUsage(t *testing.T) {
	ctx, s, now := newAnalyticsStore(t)
	r, err := s.AnalyticsUsage(ctx, filter(now))
	require.NoError(t, err)
	require.Equal(t, []string{"AGENT", "SESSIONS", "MEASURED", "TOTAL", "INPUT", "OUTPUT", "CACHED", "EST_COST_USD"}, r.Headers)

	byAgent := map[string][]any{}
	for _, row := range r.Rows {
		byAgent[row.Values[0].(string)] = row.Values
	}
	require.Equal(t, "2", byAgent["codex"][1])
	require.Equal(t, "2", byAgent["codex"][2])
	require.Equal(t, "3600", byAgent["codex"][3])
	require.NotEmpty(t, byAgent["codex"][7])
	require.Equal(t, "2", byAgent["claude-code"][1])
	require.Equal(t, "1", byAgent["claude-code"][2])
	require.NotEmpty(t, byAgent["claude-code"][7])
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

func TestValidAnalyticsReportsIncludesNewReports(t *testing.T) {
	for _, name := range []string{"hours", "usage_by_model", "errors_by_model", "subagents"} {
		require.Contains(t, validAnalyticsReports, name)
	}
}

// TestDispatchAnalyticsRoutesNewReports exercises the CLI's report dispatch
// for the three new reports — the wiring is the CLI's job; the SQL itself is
// covered by internal/store/analytics_test.go.
func TestDispatchAnalyticsRoutesNewReports(t *testing.T) {
	ctx, s, now := newAnalyticsStore(t)
	for _, tc := range []struct {
		report  string
		headers []string
	}{
		{"hours", []string{"HOUR", "SESSIONS"}},
		{"usage_by_model", []string{"MODEL", "SESSIONS", "TOTAL", "INPUT", "OUTPUT", "EST_COST_USD"}},
		{"errors_by_model", []string{"MODEL", "SESSIONS"}},
		{"subagents", []string{"AGENT", "PARENTS", "CHILDREN", "MAX_FANOUT"}},
	} {
		t.Run(tc.report, func(t *testing.T) {
			r, err := dispatchAnalytics(ctx, s, tc.report, filter(now))
			require.NoError(t, err)
			require.Equal(t, tc.headers, r.Headers)
		})
	}
}
