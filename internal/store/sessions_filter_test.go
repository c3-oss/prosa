package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

func ptrStr(s string) *string { return &s }

func seedFilterStore(t *testing.T) (context.Context, *Store, time.Time) {
	t.Helper()
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "store.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	now := time.Now().UTC()

	mk := func(id, agent, project string, ago time.Duration) session.Session {
		p := project
		return session.Session{
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
	}

	require.NoError(t, s.UpsertSession(ctx, mk("c1", "claude-code", "/u/proj-alpha", 1*time.Hour), nil))
	require.NoError(t, s.UpsertSession(ctx, mk("c2", "claude-code", "/u/proj-beta", 6*time.Hour), nil))
	require.NoError(t, s.UpsertSession(ctx, mk("x1", "codex", "/u/proj-alpha", 30*time.Minute), nil))
	require.NoError(t, s.UpsertSession(ctx, mk("x2", "codex", "/u/proj-gamma", 5*time.Hour), nil))
	return ctx, s, now
}

func TestListSessionsRangeOnly(t *testing.T) {
	ctx, s, now := seedFilterStore(t)
	got, err := s.ListSessions(ctx, SessionFilter{Since: now.Add(-7 * 24 * time.Hour), Until: now})
	require.NoError(t, err)
	require.Len(t, got, 4)
	// Newest first.
	require.Equal(t, "x1", got[0].ID)
}

func TestListSessionsByAgent(t *testing.T) {
	ctx, s, now := seedFilterStore(t)
	got, err := s.ListSessions(ctx, SessionFilter{
		Since: now.Add(-7 * 24 * time.Hour),
		Until: now,
		Agent: ptrStr("codex"),
	})
	require.NoError(t, err)
	require.Len(t, got, 2)
	for _, sess := range got {
		require.Equal(t, "codex", sess.Agent)
	}
}

func TestListSessionsByProjectExact(t *testing.T) {
	ctx, s, now := seedFilterStore(t)
	got, err := s.ListSessions(ctx, SessionFilter{
		Since:        now.Add(-7 * 24 * time.Hour),
		Until:        now,
		ProjectExact: ptrStr("/u/proj-alpha"),
	})
	require.NoError(t, err)
	require.Len(t, got, 2)
	for _, sess := range got {
		require.NotNil(t, sess.ProjectPath)
		require.Equal(t, "/u/proj-alpha", *sess.ProjectPath)
	}
}

func TestListSessionsByProjectRemote(t *testing.T) {
	ctx, s, now := seedFilterStore(t)
	// Tag two of the four sessions with a project_remote.
	_, _, err := s.FillProjectIdentity(ctx, "/u/proj-alpha", "git@github.com:x/alpha.git", "")
	require.NoError(t, err)

	url := "git@github.com:x/alpha.git"
	got, err := s.ListSessions(ctx, SessionFilter{
		Since:         now.Add(-7 * 24 * time.Hour),
		Until:         now,
		ProjectRemote: &url,
	})
	require.NoError(t, err)
	require.Len(t, got, 2) // c1 + x1 share /u/proj-alpha
}

func TestListSessionsByProjectMarker(t *testing.T) {
	ctx, s, now := seedFilterStore(t)
	_, _, err := s.FillProjectIdentity(ctx, "/u/proj-beta", "", "beta-monorepo")
	require.NoError(t, err)

	marker := "beta-monorepo"
	got, err := s.ListSessions(ctx, SessionFilter{
		Since:         now.Add(-24 * time.Hour),
		Until:         now,
		ProjectMarker: &marker,
	})
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, "c2", got[0].ID)
}

func TestListSessionsByProjectSubstring(t *testing.T) {
	ctx, s, now := seedFilterStore(t)
	got, err := s.ListSessions(ctx, SessionFilter{
		Since:        now.Add(-7 * 24 * time.Hour),
		Until:        now,
		ProjectMatch: ptrStr("alpha"),
	})
	require.NoError(t, err)
	require.Len(t, got, 2)
}

func TestListSessionsByDeviceName(t *testing.T) {
	ctx, s, now := seedFilterStore(t)
	got, err := s.ListSessions(ctx, SessionFilter{
		Since:      now.Add(-7 * 24 * time.Hour),
		Until:      now,
		DeviceName: ptrStr("local"),
	})
	require.NoError(t, err)
	require.Len(t, got, 4)

	got, err = s.ListSessions(ctx, SessionFilter{
		Since:      now.Add(-7 * 24 * time.Hour),
		Until:      now,
		DeviceName: ptrStr("nonexistent"),
	})
	require.NoError(t, err)
	require.Empty(t, got)
}

func TestListSessionsComposedFilters(t *testing.T) {
	ctx, s, now := seedFilterStore(t)
	got, err := s.ListSessions(ctx, SessionFilter{
		Since:        now.Add(-7 * 24 * time.Hour),
		Until:        now,
		Agent:        ptrStr("codex"),
		ProjectMatch: ptrStr("alpha"),
	})
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, "x1", got[0].ID)
}

func TestListSessionsRangeNarrowing(t *testing.T) {
	ctx, s, now := seedFilterStore(t)
	got, err := s.ListSessions(ctx, SessionFilter{
		Since: now.Add(-2 * time.Hour),
		Until: now,
	})
	require.NoError(t, err)
	require.Len(t, got, 2) // c1 (1h ago) and x1 (30min ago) only
}

func TestDistinctProjectPaths(t *testing.T) {
	ctx, s, _ := seedFilterStore(t)
	paths, err := s.DistinctProjectPaths(ctx)
	require.NoError(t, err)
	require.ElementsMatch(t,
		[]string{"/u/proj-alpha", "/u/proj-beta", "/u/proj-gamma"},
		paths,
	)
}

func TestListSessionsLimit(t *testing.T) {
	ctx, s, now := seedFilterStore(t)
	got, err := s.ListSessions(ctx, SessionFilter{
		Since: now.Add(-7 * 24 * time.Hour),
		Until: now,
		Limit: 2,
	})
	require.NoError(t, err)
	require.Len(t, got, 2)
	// Newest first by ordering.
	require.Equal(t, "x1", got[0].ID)
	require.Equal(t, "c1", got[1].ID)
}

func TestListSessionsLimitZeroReturnsAll(t *testing.T) {
	ctx, s, now := seedFilterStore(t)
	got, err := s.ListSessions(ctx, SessionFilter{
		Since: now.Add(-7 * 24 * time.Hour),
		Until: now,
		Limit: 0,
	})
	require.NoError(t, err)
	require.Len(t, got, 4)
}

func TestListSessionsProjectMatchSpansPathRemoteMarker(t *testing.T) {
	ctx, s, now := seedFilterStore(t)

	// Tag one session by remote, another by marker, leaving a third
	// matched only by path. All three should turn up under one
	// --project substring.
	_, _, err := s.FillProjectIdentity(ctx, "/u/proj-alpha", "git@github.com:movaincentivo/iac.git", "")
	require.NoError(t, err)
	_, _, err = s.FillProjectIdentity(ctx, "/u/proj-beta", "", "movaincentivo-monorepo")
	require.NoError(t, err)

	got, err := s.ListSessions(ctx, SessionFilter{
		Since:        now.Add(-7 * 24 * time.Hour),
		Until:        now,
		ProjectMatch: ptrStr("movaincentivo"),
	})
	require.NoError(t, err)
	ids := make(map[string]struct{}, len(got))
	for _, g := range got {
		ids[g.ID] = struct{}{}
	}
	// c1 + x1 share /u/proj-alpha (matched via project_remote);
	// c2 has project_marker = "movaincentivo-monorepo".
	require.Contains(t, ids, "c1")
	require.Contains(t, ids, "x1")
	require.Contains(t, ids, "c2")
	require.NotContains(t, ids, "x2", "proj-gamma should not match movaincentivo")
}
