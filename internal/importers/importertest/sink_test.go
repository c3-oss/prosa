package importertest

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/importer"
)

var (
	_ importer.Sink      = (*Sink)(nil)
	_ importer.SkipCache = (*Sink)(nil)
)

func TestSinkSkipCacheStoresBySessionAndReason(t *testing.T) {
	sink := NewSink()
	ctx := context.Background()

	require.NoError(t, sink.RecordImportSkip(ctx, "session-a", "hash-no-usage", importer.SkipReasonNoUsage))
	require.NoError(t, sink.RecordImportSkip(ctx, "session-a", "hash-state", importer.SkipReasonStateSeen))
	require.NoError(t, sink.RecordImportSkip(ctx, "session-b", "hash-other", importer.SkipReasonNoUsage))

	hash, found, err := sink.LastImportSkip(ctx, "session-a", importer.SkipReasonNoUsage)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, "hash-no-usage", hash)

	hash, found, err = sink.LastImportSkip(ctx, "session-a", importer.SkipReasonStateSeen)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, "hash-state", hash)

	hash, found, err = sink.LastImportSkip(ctx, "session-b", importer.SkipReasonNoUsage)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, "hash-other", hash)

	_, found, err = sink.LastImportSkip(ctx, "session-b", importer.SkipReasonStateSeen)
	require.NoError(t, err)
	require.False(t, found)
}
