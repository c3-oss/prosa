package pricing

import (
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/c3-oss/prosa/pkg/session"
)

// Rates are USD-per-token prices. The table is intentionally embedded and
// conservative; unknown models return priced=false instead of guessing.
type Rates struct {
	Input         float64
	Output        float64
	CacheRead     float64
	CacheCreation float64
}

type ratePeriod struct {
	From  time.Time
	Rates Rates
}

var sonnet5StandardFrom = time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)

func fixed(r Rates) []ratePeriod {
	return []ratePeriod{{Rates: r}}
}

var ratesByModel = map[string][]ratePeriod{
	// Anthropic — Claude 4 generation.
	// Opus 4.0 / 4.1 use the legacy pricing; 4.5+ moved to the cheaper tier.
	"claude-opus-4":     fixed(Rates{Input: 1.5e-5, Output: 7.5e-5, CacheRead: 1.5e-6, CacheCreation: 1.875e-5}),
	"claude-opus-4-0":   fixed(Rates{Input: 1.5e-5, Output: 7.5e-5, CacheRead: 1.5e-6, CacheCreation: 1.875e-5}),
	"claude-opus-4-1":   fixed(Rates{Input: 1.5e-5, Output: 7.5e-5, CacheRead: 1.5e-6, CacheCreation: 1.875e-5}),
	"claude-opus-4-5":   fixed(Rates{Input: 5.0e-6, Output: 2.5e-5, CacheRead: 5.0e-7, CacheCreation: 6.25e-6}),
	"claude-opus-4-6":   fixed(Rates{Input: 5.0e-6, Output: 2.5e-5, CacheRead: 5.0e-7, CacheCreation: 6.25e-6}),
	"claude-opus-4-7":   fixed(Rates{Input: 5.0e-6, Output: 2.5e-5, CacheRead: 5.0e-7, CacheCreation: 6.25e-6}),
	"claude-opus-4-8":   fixed(Rates{Input: 5.0e-6, Output: 2.5e-5, CacheRead: 5.0e-7, CacheCreation: 6.25e-6}),
	"claude-sonnet-4":   fixed(Rates{Input: 3.0e-6, Output: 1.5e-5, CacheRead: 3.0e-7, CacheCreation: 3.75e-6}),
	"claude-sonnet-4-0": fixed(Rates{Input: 3.0e-6, Output: 1.5e-5, CacheRead: 3.0e-7, CacheCreation: 3.75e-6}),
	"claude-sonnet-4-5": fixed(Rates{Input: 3.0e-6, Output: 1.5e-5, CacheRead: 3.0e-7, CacheCreation: 3.75e-6}),
	"claude-sonnet-4-6": fixed(Rates{Input: 3.0e-6, Output: 1.5e-5, CacheRead: 3.0e-7, CacheCreation: 3.75e-6}),
	"claude-sonnet-5": {
		{Rates: Rates{Input: 2.0e-6, Output: 1.0e-5, CacheRead: 2.0e-7, CacheCreation: 2.5e-6}},
		{From: sonnet5StandardFrom, Rates: Rates{Input: 3.0e-6, Output: 1.5e-5, CacheRead: 3.0e-7, CacheCreation: 3.75e-6}},
	},
	"claude-haiku-4-5": fixed(Rates{Input: 1.0e-6, Output: 5.0e-6, CacheRead: 1.0e-7, CacheCreation: 1.25e-6}),
	"claude-fable-5":   fixed(Rates{Input: 1.0e-5, Output: 5.0e-5, CacheRead: 1.0e-6, CacheCreation: 1.25e-5}),

	// OpenAI — GPT-5 generation.
	"gpt-5":               fixed(Rates{Input: 1.25e-6, Output: 1.0e-5, CacheRead: 1.25e-7}),
	"gpt-5-chat-latest":   fixed(Rates{Input: 1.25e-6, Output: 1.0e-5, CacheRead: 1.25e-7}),
	"gpt-5-codex":         fixed(Rates{Input: 1.25e-6, Output: 1.0e-5, CacheRead: 1.25e-7}),
	"gpt-5-mini":          fixed(Rates{Input: 2.5e-7, Output: 2.0e-6, CacheRead: 2.5e-8}),
	"gpt-5-nano":          fixed(Rates{Input: 5.0e-8, Output: 4.0e-7, CacheRead: 5.0e-9}),
	"gpt-5-pro":           fixed(Rates{Input: 1.5e-5, Output: 1.2e-4}),
	"gpt-5.1":             fixed(Rates{Input: 1.25e-6, Output: 1.0e-5, CacheRead: 1.25e-7}),
	"gpt-5.1-codex":       fixed(Rates{Input: 1.25e-6, Output: 1.0e-5, CacheRead: 1.25e-7}),
	"gpt-5.1-codex-max":   fixed(Rates{Input: 1.25e-6, Output: 1.0e-5, CacheRead: 1.25e-7}),
	"gpt-5.1-codex-mini":  fixed(Rates{Input: 2.5e-7, Output: 2.0e-6, CacheRead: 2.5e-8}),
	"gpt-5.2":             fixed(Rates{Input: 1.75e-6, Output: 1.4e-5, CacheRead: 1.75e-7}),
	"gpt-5.2-codex":       fixed(Rates{Input: 1.75e-6, Output: 1.4e-5, CacheRead: 1.75e-7}),
	"gpt-5.2-pro":         fixed(Rates{Input: 2.1e-5, Output: 1.68e-4}),
	"gpt-5.3-codex":       fixed(Rates{Input: 1.75e-6, Output: 1.4e-5, CacheRead: 1.75e-7}),
	"gpt-5.3-codex-spark": fixed(Rates{Input: 1.75e-6, Output: 1.4e-5, CacheRead: 1.75e-7}),
	"gpt-5.3-codex-xhigh": fixed(Rates{Input: 1.75e-6, Output: 1.4e-5, CacheRead: 1.75e-7}),
	"gpt-5.4":             fixed(Rates{Input: 2.5e-6, Output: 1.5e-5, CacheRead: 2.5e-7}),
	"gpt-5.4-mini":        fixed(Rates{Input: 7.5e-7, Output: 4.5e-6, CacheRead: 7.5e-8}),
	"gpt-5.4-nano":        fixed(Rates{Input: 2.0e-7, Output: 1.25e-6, CacheRead: 2.0e-8}),
	"gpt-5.4-pro":         fixed(Rates{Input: 3.0e-5, Output: 1.8e-4}),
	"gpt-5.5":             fixed(Rates{Input: 5.0e-6, Output: 3.0e-5, CacheRead: 5.0e-7}),
	"gpt-5.5-pro":         fixed(Rates{Input: 3.0e-5, Output: 1.8e-4}),

	// Google — Gemini 2.5 / 3 / 3.5 generation.
	// Tier-pricing for >200k context is not yet modelled; we use the base tariff for every call.
	"gemini-2.5-pro":         fixed(Rates{Input: 1.25e-6, Output: 1.0e-5, CacheRead: 1.25e-7}),
	"gemini-2.5-flash":       fixed(Rates{Input: 3.0e-7, Output: 2.5e-6, CacheRead: 3.0e-8}),
	"gemini-2.5-flash-lite":  fixed(Rates{Input: 1.0e-7, Output: 4.0e-7, CacheRead: 1.0e-8}),
	"gemini-3-pro-preview":   fixed(Rates{Input: 2.0e-6, Output: 1.2e-5, CacheRead: 2.0e-7}),
	"gemini-3-flash-preview": fixed(Rates{Input: 5.0e-7, Output: 3.0e-6, CacheRead: 5.0e-8}),
	"gemini-3.5-flash":       fixed(Rates{Input: 1.5e-6, Output: 9.0e-6, CacheRead: 1.5e-7}),

	// Cursor — Composer generation. Fast (default) pricing; no cache tier.
	"composer-2.5": fixed(Rates{Input: 3.0e-6, Output: 1.5e-5}),
}

// modelAliases maps dot-form or reordered model ids to their canonical key in ratesByModel.
var modelAliases = map[string]string{
	"claude-opus-4.5":   "claude-opus-4-5",
	"claude-opus-4.6":   "claude-opus-4-6",
	"claude-opus-4.7":   "claude-opus-4-7",
	"claude-sonnet-4.5": "claude-sonnet-4-5",
	"claude-sonnet-4.6": "claude-sonnet-4-6",
	"claude-haiku-4.5":  "claude-haiku-4-5",
	"gpt-codex-5.3":     "gpt-5.3-codex",
}

var (
	datedSuffixRE = regexp.MustCompile(`-\d{8}$|-\d{4}-\d{2}-\d{2}$`)

	prefixKeysOnce sync.Once
	prefixKeys     []string
)

// CostUSD estimates one session's usage cost. cached_tokens is treated as
// cache-read input when the provider does not expose the read/create split.
func CostUSD(model string, usage session.TokenUsage, at time.Time) (float64, bool) {
	r, ok := Lookup(model, at)
	if !ok {
		return 0, false
	}

	cacheRead := usage.CacheReadTokens
	if cacheRead == 0 {
		cacheRead = usage.CachedTokens
	}
	if cacheRead > usage.InputTokens {
		cacheRead = usage.InputTokens
	}
	uncachedInput := usage.InputTokens - cacheRead - usage.CacheCreationTokens
	if uncachedInput < 0 {
		uncachedInput = 0
	}

	cost := float64(uncachedInput)*r.Input +
		float64(cacheRead)*r.CacheRead +
		float64(usage.CacheCreationTokens)*r.CacheCreation +
		float64(usage.OutputTokens)*r.Output
	return cost, true
}

// Lookup resolves rates for a raw model string. Falls back to a longest-prefix
// match so versioned variants (e.g. claude-opus-4-7) don't collapse onto a
// shorter key (claude-opus-4) with a different price tier.
func Lookup(model string, at time.Time) (Rates, bool) {
	norm := NormalizeModel(model)
	if norm == "" {
		return Rates{}, false
	}
	if canon, ok := modelAliases[norm]; ok {
		norm = canon
	}
	if periods, ok := ratesByModel[norm]; ok {
		return rateAt(periods, at)
	}
	for _, key := range sortedPrefixKeys() {
		if strings.HasPrefix(norm, key+"-") {
			return rateAt(ratesByModel[key], at)
		}
	}
	return Rates{}, false
}

func rateAt(periods []ratePeriod, at time.Time) (Rates, bool) {
	if len(periods) == 0 {
		return Rates{}, false
	}
	if at.IsZero() {
		return periods[len(periods)-1].Rates, true
	}
	out := periods[0].Rates
	for _, p := range periods {
		if !at.Before(p.From) {
			out = p.Rates
		}
	}
	return out, true
}

// NormalizeModel strips provider prefixes, vendor-tag suffixes, and dated
// snapshot suffixes so a family stays priced after the snapshot date rotates.
func NormalizeModel(model string) string {
	s := strings.ToLower(strings.TrimSpace(model))
	s = strings.TrimPrefix(s, "openai/")
	s = strings.TrimPrefix(s, "anthropic/")
	s = strings.TrimPrefix(s, "anthropic.")
	s = strings.TrimPrefix(s, "google/")
	if at := strings.IndexByte(s, '@'); at >= 0 {
		s = s[:at]
	}
	return datedSuffixRE.ReplaceAllString(s, "")
}

// sortedPrefixKeys returns rate-table keys ordered longest-first so the prefix
// match in Lookup is deterministic despite Go's randomised map iteration.
func sortedPrefixKeys() []string {
	prefixKeysOnce.Do(func() {
		prefixKeys = make([]string, 0, len(ratesByModel))
		for k := range ratesByModel {
			prefixKeys = append(prefixKeys, k)
		}
		sort.Slice(prefixKeys, func(i, j int) bool {
			if len(prefixKeys[i]) != len(prefixKeys[j]) {
				return len(prefixKeys[i]) > len(prefixKeys[j])
			}
			return prefixKeys[i] < prefixKeys[j]
		})
	})
	return prefixKeys
}
