package pricing

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

var pricingTestTime = time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)

func TestCostUSDUsesCachedRate(t *testing.T) {
	cost, ok := CostUSD("openai/gpt-5-codex-20250530", session.TokenUsage{
		InputTokens:     1000,
		OutputTokens:    100,
		CachedTokens:    400,
		CacheReadTokens: 400,
	}, pricingTestTime)
	require.True(t, ok)
	require.InDelta(t, 0.0018, cost, 0.00001)
}

func TestCostUSDUnknownModel(t *testing.T) {
	_, ok := CostUSD("unknown-model", session.TokenUsage{InputTokens: 100}, pricingTestTime)
	require.False(t, ok)
}

func TestCostUSDSyntheticAndPlaceholderUnpriced(t *testing.T) {
	for _, m := range []string{"<synthetic>", "not-a-real-model-name", ""} {
		_, ok := CostUSD(m, session.TokenUsage{InputTokens: 100}, pricingTestTime)
		require.False(t, ok, "%q should be unpriced", m)
	}
}

func TestCostUSDPricesClaudeCacheCreationSeparately(t *testing.T) {
	cost, ok := CostUSD("claude-sonnet-4-6", session.TokenUsage{
		InputTokens:         115,
		OutputTokens:        20,
		CachedTokens:        10,
		CacheReadTokens:     10,
		CacheCreationTokens: 5,
	}, pricingTestTime)
	require.True(t, ok)
	require.InDelta(t, 0.00062175, cost, 0.00000001)
}

func TestCostUSDPricesFable5(t *testing.T) {
	cost, ok := CostUSD("claude-fable-5", session.TokenUsage{
		InputTokens:         1000,
		OutputTokens:        200,
		CachedTokens:        300,
		CacheReadTokens:     300,
		CacheCreationTokens: 100,
	}, pricingTestTime)
	require.True(t, ok)
	require.InDelta(t, 0.01755, cost, 0.00000001)
}

func TestCostUSDPricesSonnet5ByDate(t *testing.T) {
	usage := session.TokenUsage{
		InputTokens:         1000,
		OutputTokens:        200,
		CachedTokens:        300,
		CacheReadTokens:     300,
		CacheCreationTokens: 100,
	}

	intro, ok := CostUSD("claude-sonnet-5", usage, time.Date(2026, 8, 31, 23, 59, 59, 0, time.UTC))
	require.True(t, ok)
	require.InDelta(t, 0.00351, intro, 0.00000001)

	standard, ok := CostUSD("claude-sonnet-5", usage, sonnet5StandardFrom)
	require.True(t, ok)
	require.InDelta(t, 0.005265, standard, 0.00000001)
}

// TestLookupKnownModelsFromRealStore covers every model id observed in
// the maintainer's local store at the time of this commit. Each entry
// must return priced=true so that future regressions in the matcher
// surface as a failing test instead of a silent n/a in the report.
func TestLookupKnownModelsFromRealStore(t *testing.T) {
	cases := []struct {
		model string
		want  Rates
	}{
		{"claude-opus-4-7", Rates{Input: 5.0e-6, Output: 2.5e-5, CacheRead: 5.0e-7, CacheCreation: 6.25e-6}},
		{"claude-opus-4-6", Rates{Input: 5.0e-6, Output: 2.5e-5, CacheRead: 5.0e-7, CacheCreation: 6.25e-6}},
		{"claude-opus-4-5-20251101", Rates{Input: 5.0e-6, Output: 2.5e-5, CacheRead: 5.0e-7, CacheCreation: 6.25e-6}},
		{"claude-opus-4.6", Rates{Input: 5.0e-6, Output: 2.5e-5, CacheRead: 5.0e-7, CacheCreation: 6.25e-6}},
		{"claude-opus-4.7", Rates{Input: 5.0e-6, Output: 2.5e-5, CacheRead: 5.0e-7, CacheCreation: 6.25e-6}},
		{"claude-sonnet-4-6", Rates{Input: 3.0e-6, Output: 1.5e-5, CacheRead: 3.0e-7, CacheCreation: 3.75e-6}},
		{"claude-sonnet-4-5-20250929", Rates{Input: 3.0e-6, Output: 1.5e-5, CacheRead: 3.0e-7, CacheCreation: 3.75e-6}},
		{"claude-sonnet-5", Rates{Input: 2.0e-6, Output: 1.0e-5, CacheRead: 2.0e-7, CacheCreation: 2.5e-6}},
		{"claude-haiku-4-5-20251001", Rates{Input: 1.0e-6, Output: 5.0e-6, CacheRead: 1.0e-7, CacheCreation: 1.25e-6}},
		{"claude-haiku-4.5", Rates{Input: 1.0e-6, Output: 5.0e-6, CacheRead: 1.0e-7, CacheCreation: 1.25e-6}},
		{"claude-fable-5", Rates{Input: 1.0e-5, Output: 5.0e-5, CacheRead: 1.0e-6, CacheCreation: 1.25e-5}},
		{"claude-fable-5-20260601", Rates{Input: 1.0e-5, Output: 5.0e-5, CacheRead: 1.0e-6, CacheCreation: 1.25e-5}},
		{"composer-2.5", Rates{Input: 3.0e-6, Output: 1.5e-5}},

		// OpenAI GPT-5 family — the live store has minor versions 5.0
		// through 5.5 plus the codex / mini / nano variants.
		{"gpt-5", Rates{Input: 1.25e-6, Output: 1.0e-5, CacheRead: 1.25e-7}},
		{"gpt-5-codex", Rates{Input: 1.25e-6, Output: 1.0e-5, CacheRead: 1.25e-7}},
		{"gpt-5.1", Rates{Input: 1.25e-6, Output: 1.0e-5, CacheRead: 1.25e-7}},
		{"gpt-5.1-codex", Rates{Input: 1.25e-6, Output: 1.0e-5, CacheRead: 1.25e-7}},
		{"gpt-5.1-codex-max", Rates{Input: 1.25e-6, Output: 1.0e-5, CacheRead: 1.25e-7}},
		{"gpt-5.1-codex-mini", Rates{Input: 2.5e-7, Output: 2.0e-6, CacheRead: 2.5e-8}},
		{"gpt-5.2", Rates{Input: 1.75e-6, Output: 1.4e-5, CacheRead: 1.75e-7}},
		{"gpt-5.2-codex", Rates{Input: 1.75e-6, Output: 1.4e-5, CacheRead: 1.75e-7}},
		{"gpt-5.3-codex", Rates{Input: 1.75e-6, Output: 1.4e-5, CacheRead: 1.75e-7}},
		{"gpt-5.3-codex-spark", Rates{Input: 1.75e-6, Output: 1.4e-5, CacheRead: 1.75e-7}},
		{"gpt-5.4", Rates{Input: 2.5e-6, Output: 1.5e-5, CacheRead: 2.5e-7}},
		{"gpt-5.4-mini", Rates{Input: 7.5e-7, Output: 4.5e-6, CacheRead: 7.5e-8}},
		{"gpt-5.5", Rates{Input: 5.0e-6, Output: 3.0e-5, CacheRead: 5.0e-7}},
		{"gpt-codex-5.3", Rates{Input: 1.75e-6, Output: 1.4e-5, CacheRead: 1.75e-7}},

		{"gemini-2.5-pro", Rates{Input: 1.25e-6, Output: 1.0e-5, CacheRead: 1.25e-7}},
		{"gemini-2.5-flash", Rates{Input: 3.0e-7, Output: 2.5e-6, CacheRead: 3.0e-8}},
		{"gemini-2.5-flash-lite", Rates{Input: 1.0e-7, Output: 4.0e-7, CacheRead: 1.0e-8}},
		{"gemini-3-pro-preview", Rates{Input: 2.0e-6, Output: 1.2e-5, CacheRead: 2.0e-7}},
		{"gemini-3-flash-preview", Rates{Input: 5.0e-7, Output: 3.0e-6, CacheRead: 5.0e-8}},
		// Antigravity emits gemini-3.5-flash with a thinking-level
		// suffix (-low/-medium/-high/-minimal); all map to the same
		// per-token rate via the longest-prefix fallback.
		{"gemini-3.5-flash", Rates{Input: 1.5e-6, Output: 9.0e-6, CacheRead: 1.5e-7}},
		{"gemini-3.5-flash-low", Rates{Input: 1.5e-6, Output: 9.0e-6, CacheRead: 1.5e-7}},
		{"gemini-3.5-flash-medium", Rates{Input: 1.5e-6, Output: 9.0e-6, CacheRead: 1.5e-7}},
		{"gemini-3.5-flash-high", Rates{Input: 1.5e-6, Output: 9.0e-6, CacheRead: 1.5e-7}},
		{"gemini-3.5-flash-minimal", Rates{Input: 1.5e-6, Output: 9.0e-6, CacheRead: 1.5e-7}},
	}
	for _, tc := range cases {
		t.Run(tc.model, func(t *testing.T) {
			got, ok := Lookup(tc.model, pricingTestTime)
			require.True(t, ok, "expected %q to be priced", tc.model)
			require.Equal(t, tc.want, got)
		})
	}
}

// TestLookupOpus47DoesNotInheritOpus4Rate guards the regression that
// shipped in the first usage cut: claude-opus-4-7 was matching the
// claude-opus-4 prefix and being charged 3× the correct rate.
func TestLookupOpus47DoesNotInheritOpus4Rate(t *testing.T) {
	got, ok := Lookup("claude-opus-4-7", pricingTestTime)
	require.True(t, ok)
	require.Equal(t, 5.0e-6, got.Input, "opus-4-7 must use the cheaper 4.5+ input rate, not opus-4's $15/M")
	require.Equal(t, 2.5e-5, got.Output, "opus-4-7 must use the cheaper 4.5+ output rate, not opus-4's $75/M")
}

// TestLookupDeterministic guards against Go's randomised map iteration:
// repeated lookups for an unmatched variant must always pick the same row.
func TestLookupDeterministic(t *testing.T) {
	first, ok := Lookup("claude-opus-4-99-rc", pricingTestTime)
	require.True(t, ok, "fallback prefix match should have landed on claude-opus-4")
	for i := 0; i < 100; i++ {
		got, ok := Lookup("claude-opus-4-99-rc", pricingTestTime)
		require.True(t, ok)
		require.Equal(t, first, got, "lookup %d returned a different row", i)
	}
}

func TestNormalizeModel(t *testing.T) {
	cases := map[string]string{
		"":                            "",
		"  GPT-5  ":                   "gpt-5",
		"openai/gpt-5-codex-20250530": "gpt-5-codex",
		"anthropic/claude-opus-4-7":   "claude-opus-4-7",
		"anthropic/claude-fable-5":    "claude-fable-5",
		"anthropic.claude-opus-4-7":   "claude-opus-4-7",
		"google/gemini-2.5-pro":       "gemini-2.5-pro",
		"claude-sonnet-4-5-20250929":  "claude-sonnet-4-5",
		"claude-sonnet-5-20260701":    "claude-sonnet-5",
		"claude-haiku-4-5-20251001":   "claude-haiku-4-5",
		"gpt-5.3-codex-spark@spark":   "gpt-5.3-codex-spark",
	}
	for in, want := range cases {
		require.Equal(t, want, NormalizeModel(in), in)
	}
}
