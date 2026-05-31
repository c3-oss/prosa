package session

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestHasTokenUsage(t *testing.T) {
	require.False(t, HasTokenUsage(nil))
	require.False(t, HasTokenUsage(&TokenUsage{}))
	require.True(t, HasTokenUsage(&TokenUsage{TotalTokens: 1}))
	require.True(t, HasTokenUsage(&TokenUsage{InputTokens: 1}))
	require.True(t, HasTokenUsage(&TokenUsage{OutputTokens: 1}))
	require.True(t, HasTokenUsage(&TokenUsage{CachedTokens: 1}))
	require.True(t, HasTokenUsage(&TokenUsage{CacheReadTokens: 1}))
	require.True(t, HasTokenUsage(&TokenUsage{CacheCreationTokens: 1}))
}
