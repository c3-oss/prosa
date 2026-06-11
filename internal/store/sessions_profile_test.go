package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

func seedProfileStore(t *testing.T) (context.Context, *Store, time.Time) {
	t.Helper()
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "store.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	now := time.Now().UTC()

	mk := func(id, agent, profile string, ago time.Duration) session.Session {
		return session.Session{
			ID:             id,
			Agent:          agent,
			DeviceID:       "local",
			Profile:        profile,
			StartedAt:      now.Add(-ago),
			LastActivityAt: now.Add(-ago + time.Minute),
			RawPath:        "/tmp/" + id + ".jsonl",
			RawHash:        "h-" + id,
			RawSize:        100,
		}
	}

	require.NoError(t, s.UpsertSession(ctx, mk("x1", "codex", "default", 1*time.Hour), nil))
	require.NoError(t, s.UpsertSession(ctx, mk("x2", "codex", "work", 2*time.Hour), nil))
	require.NoError(t, s.UpsertSession(ctx, mk("x3", "codex", "work", 3*time.Hour), nil))
	// Empty profile must normalise to "default" on write.
	require.NoError(t, s.UpsertSession(ctx, mk("c1", "claude-code", "", 4*time.Hour), nil))
	return ctx, s, now
}

func TestSessionProfileRoundTrip(t *testing.T) {
	t.Parallel()
	ctx, s, _ := seedProfileStore(t)
	got, err := s.GetSession(ctx, "c1")
	require.NoError(t, err)
	require.Equal(t, "default", got.Profile, "empty profile must read back as default")

	got, err = s.GetSession(ctx, "x2")
	require.NoError(t, err)
	require.Equal(t, "work", got.Profile)
}

func TestListSessionsByProfile(t *testing.T) {
	t.Parallel()
	ctx, s, now := seedProfileStore(t)
	got, err := s.ListSessions(ctx, SessionFilter{
		Since:   now.Add(-7 * 24 * time.Hour),
		Until:   now,
		Profile: ptrStr("work"),
	})
	require.NoError(t, err)
	require.Len(t, got, 2)
	for _, sess := range got {
		require.Equal(t, "work", sess.Profile)
	}
}

func TestProfileCounts(t *testing.T) {
	t.Parallel()
	ctx, s, _ := seedProfileStore(t)
	counts, err := s.ProfileCounts(ctx)
	require.NoError(t, err)

	got := map[string]int{}
	for _, pc := range counts {
		got[pc.Agent+"/"+pc.Profile] = pc.Count
	}
	require.Equal(t, 1, got["codex/default"])
	require.Equal(t, 2, got["codex/work"])
	require.Equal(t, 1, got["claude-code/default"])
}
