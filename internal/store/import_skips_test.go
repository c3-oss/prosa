package store

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestImportSkipRoundTrip(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "store.db"))
	require.NoError(t, err)
	defer s.Close()

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
