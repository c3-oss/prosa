package pricing

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

func TestCostUSDUsesCachedRate(t *testing.T) {
	cost, ok := CostUSD("openai/gpt-5-codex-20250530", session.TokenUsage{
		InputTokens:     1000,
		OutputTokens:    100,
		CachedTokens:    400,
		CacheReadTokens: 400,
	})
	require.True(t, ok)
	require.InDelta(t, 0.0018, cost, 0.00001)
}

func TestCostUSDUnknownModel(t *testing.T) {
	_, ok := CostUSD("unknown-model", session.TokenUsage{InputTokens: 100})
	require.False(t, ok)
}

func TestCostUSDPricesClaudeCacheCreationSeparately(t *testing.T) {
	cost, ok := CostUSD("claude-sonnet-4-6", session.TokenUsage{
		InputTokens:         115,
		OutputTokens:        20,
		CachedTokens:        10,
		CacheReadTokens:     10,
		CacheCreationTokens: 5,
	})
	require.True(t, ok)
	require.InDelta(t, 0.00062175, cost, 0.00000001)
}
