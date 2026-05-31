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
	require.True(
		t,
		strings.Contains(hits[0].Snippet, SnippetMarkStart+"terraform"+SnippetMarkEnd),
		"snippet should wrap the matched term: got %q", hits[0].Snippet,
	)
}

func TestSearchProjectMatchSpansPathRemoteMarker(t *testing.T) {
	ctx, s, now := seedSearchStore(t)
	// Tag the alpha sessions with a remote; the beta session with a marker.
	_, _, err := s.FillProjectIdentity(ctx, "/u/proj-alpha", "git@github.com:movaincentivo/iac.git", "")
	require.NoError(t, err)
	_, _, err = s.FillProjectIdentity(ctx, "/u/proj-beta", "", "movaincentivo-monorepo")
	require.NoError(t, err)

	// Common query term that matches every session content.
	hits, err := s.Search(ctx, "quantum OR terraform", SessionFilter{
		Since:        now.Add(-24 * time.Hour),
		Until:        now,
		ProjectMatch: ptrStr("movaincentivo"),
	}, 10)
	require.NoError(t, err)
	ids := map[string]struct{}{}
	for _, h := range hits {
		ids[h.Session.ID] = struct{}{}
	}
	require.Contains(t, ids, "a", "alpha session matches via project_remote")
	require.Contains(t, ids, "c", "alpha session matches via project_remote")
	require.Contains(t, ids, "b", "beta session matches via project_marker")
}

func TestSearchFilterByProjectRemote(t *testing.T) {
	ctx, s, now := seedSearchStore(t)
	_, _, err := s.FillProjectIdentity(ctx, "/u/proj-alpha", "git@github.com:org/alpha.git", "")
	require.NoError(t, err)

	url := "git@github.com:org/alpha.git"
	hits, err := s.Search(ctx, "quantum", SessionFilter{
		Since:         now.Add(-24 * time.Hour),
		Until:         now,
		ProjectRemote: &url,
	}, 10)
	require.NoError(t, err)
	for _, h := range hits {
		require.NotNil(t, h.Session.ProjectRemote)
		require.Equal(t, url, *h.Session.ProjectRemote)
	}
	require.NotEmpty(t, hits)
}

func TestSearchFilterByProjectMarker(t *testing.T) {
	ctx, s, now := seedSearchStore(t)
	_, _, err := s.FillProjectIdentity(ctx, "/u/proj-beta", "", "beta-monorepo")
	require.NoError(t, err)

	marker := "beta-monorepo"
	hits, err := s.Search(ctx, "terraform", SessionFilter{
		Since:         now.Add(-24 * time.Hour),
		Until:         now,
		ProjectMarker: &marker,
	}, 10)
	require.NoError(t, err)
	require.Len(t, hits, 1)
	require.Equal(t, "b", hits[0].Session.ID)
}

func TestSearchSurfacesEvidenceMetadata(t *testing.T) {
	ctx, s, now := seedSearchStore(t)

	// Project a tool_result into session "a".
	require.NoError(t, s.InsertTurns(ctx, "a", []session.Turn{
		{Role: "user", Content: "explain quantum entanglement in plain terms", Timestamp: now.Add(-time.Hour)},
		{
			Role:      "tool",
			Content:   "npm test failed with exit code 1\nNetworkError: ECONNREFUSED",
			Timestamp: now.Add(-50 * time.Minute),
			Kind:      session.KindToolResult,
			ToolName:  "Bash",
		},
	}))

	hits, err := s.Search(ctx, "ECONNREFUSED", SessionFilter{
		Since: now.Add(-24 * time.Hour), Until: now,
	}, 10)
	require.NoError(t, err)
	require.Len(t, hits, 1)
	h := hits[0]
	require.Equal(t, "a", h.Session.ID)
	require.Equal(t, "tool", h.Role)
	require.Equal(t, session.KindToolResult, h.Kind)
	require.Equal(t, "Bash", h.ToolName)
	require.Equal(t, MatchFieldTurnContent, h.MatchField)
	require.NotZero(t, h.TurnID)
	require.False(t, h.TurnTS.IsZero())
}

func TestInsertTurnsRoundTripsKindAndToolName(t *testing.T) {
	ctx, s, _ := seedSearchStore(t)
	now := time.Now().UTC()
	require.NoError(t, s.InsertTurns(ctx, "a", []session.Turn{
		{Role: "user", Content: "hi", Timestamp: now, Kind: session.KindMessage},
		{
			Role: "tool", Content: "exit 0", Timestamp: now.Add(time.Second),
			Kind: session.KindToolResult, ToolName: "exec_command",
		},
	}))
	got, err := s.GetTurns(ctx, "a")
	require.NoError(t, err)
	require.Len(t, got, 2)
	require.Equal(t, session.KindMessage, got[0].Kind)
	require.Empty(t, got[0].ToolName)
	require.Equal(t, session.KindToolResult, got[1].Kind)
	require.Equal(t, "exec_command", got[1].ToolName)
}

func TestInsertTurnsDefaultsEmptyKindToMessage(t *testing.T) {
	ctx, s, _ := seedSearchStore(t)
	require.NoError(t, s.InsertTurns(ctx, "a", []session.Turn{
		{Role: "user", Content: "plain content", Timestamp: time.Now().UTC()},
	}))
	got, err := s.GetTurns(ctx, "a")
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, session.KindMessage, got[0].Kind)
}
