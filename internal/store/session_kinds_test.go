package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/internal/sessionkind"
	"github.com/c3-oss/prosa/pkg/session"
)

func seedKindsStore(t *testing.T) (context.Context, *Store, time.Time) {
	t.Helper()
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "store.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	now := time.Now().UTC()

	mk := func(id string, kinds []string, parent *string) session.Session {
		p := "/u/proj"
		return session.Session{
			ID:              id,
			Agent:           "codex",
			DeviceID:        "local",
			ProjectPath:     &p,
			StartedAt:       now.Add(-time.Hour),
			LastActivityAt:  now.Add(-time.Hour + time.Minute),
			RawPath:         "/tmp/" + id + ".jsonl",
			RawHash:         "h-" + id,
			RawSize:         100,
			Kinds:           kinds,
			ParentSessionID: parent,
		}
	}

	require.NoError(t, s.UpsertSession(ctx, mk("goal1", []string{sessionkind.KindGoal}, nil), nil))
	require.NoError(t, s.UpsertSession(ctx, mk("wf1", []string{sessionkind.KindWorkflow}, nil), nil))
	require.NoError(t, s.UpsertSession(ctx, mk("plain1", nil, nil), nil))
	require.NoError(t, s.UpsertSession(ctx, mk("child1", nil, ptrStr("goal1")), nil))
	return ctx, s, now
}

func TestSessionKindsRoundTrip(t *testing.T) {
	t.Parallel()
	ctx, s, _ := seedKindsStore(t)

	got, err := s.GetSession(ctx, "goal1")
	require.NoError(t, err)
	require.Equal(t, []string{sessionkind.KindGoal}, got.Kinds)

	plain, err := s.GetSession(ctx, "plain1")
	require.NoError(t, err)
	require.Empty(t, plain.Kinds)
}

func TestListSessionsKindsFilter(t *testing.T) {
	t.Parallel()
	ctx, s, now := seedKindsStore(t)

	got, err := s.ListSessions(ctx, SessionFilter{
		Since: now.Add(-24 * time.Hour),
		Until: now,
		Kinds: []string{sessionkind.KindGoal},
	})
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, "goal1", got[0].ID)
	require.Equal(t, []string{sessionkind.KindGoal}, got[0].Kinds)

	// OR semantics across multiple kinds.
	got, err = s.ListSessions(ctx, SessionFilter{
		Since: now.Add(-24 * time.Hour),
		Until: now,
		Kinds: []string{sessionkind.KindGoal, sessionkind.KindWorkflow},
	})
	require.NoError(t, err)
	require.Len(t, got, 2)
}

func TestRefreshOrchestratorKinds(t *testing.T) {
	t.Parallel()
	ctx, s, _ := seedKindsStore(t)

	require.NoError(t, s.RefreshOrchestratorKinds(ctx))

	// goal1 has child1, so it gains the orchestrator kind alongside goal.
	got, err := s.GetSession(ctx, "goal1")
	require.NoError(t, err)
	require.ElementsMatch(t, []string{sessionkind.KindGoal, sessionkind.KindOrchestrator}, got.Kinds)

	// wf1 has no children — no orchestrator kind.
	wf, err := s.GetSession(ctx, "wf1")
	require.NoError(t, err)
	require.Equal(t, []string{sessionkind.KindWorkflow}, wf.Kinds)

	// Idempotent + prunes when children disappear: re-upsert goal1 with no
	// kinds wipes its rows, refresh re-derives orchestrator from the edge.
	require.NoError(t, s.RefreshOrchestratorKinds(ctx))
	got, err = s.GetSession(ctx, "goal1")
	require.NoError(t, err)
	require.ElementsMatch(t, []string{sessionkind.KindGoal, sessionkind.KindOrchestrator}, got.Kinds)
}
