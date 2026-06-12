package session

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestProfileOrDefault(t *testing.T) {
	require.Equal(t, DefaultProfile, ProfileOrDefault(""))
	require.Equal(t, "default", ProfileOrDefault(""))
	require.Equal(t, "work", ProfileOrDefault("work"))
}

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
