package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/c3-oss/prosa/pkg/session"
	"github.com/stretchr/testify/require"
)

func TestImportSkipRoundTrip(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "store.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })

	hash, found, err := s.LastImportSkip(ctx, "s1", "no_usage")
	require.NoError(t, err)
	require.False(t, found)
	require.Empty(t, hash)

	require.NoError(t, s.RecordImportSkip(ctx, "s1", "h1", "no_usage"))

	hash, found, err = s.LastImportSkip(ctx, "s1", "no_usage")
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, "h1", hash)

	require.NoError(t, s.RecordImportSkip(ctx, "s1", "h2", "no_usage"))

	hash, found, err = s.LastImportSkip(ctx, "s1", "no_usage")
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, "h2", hash)
}

func TestLastImportSkipIgnoresStaleProjectionVersion(t *testing.T) {
	t.Parallel()
	ctx, s := newStore(t)
	now := time.Now().UTC()

	_, err := s.DB().ExecContext(ctx, `
		INSERT INTO import_skips (session_id, reason, last_hash, skipped_at, projection_version)
		VALUES (?, ?, ?, ?, ?)
	`, "skip-stale-projection", "no_usage", "stale-hash", formatTime(now), session.ProjectionVersion-1)
	require.NoError(t, err)

	hash, found, err := s.LastImportSkip(ctx, "skip-stale-projection", "no_usage")
	require.NoError(t, err)
	require.False(t, found)
	require.Equal(t, "stale-hash", hash)
}
