package pricing

import (
	"regexp"
	"strings"

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

var ratesByModel = map[string]Rates{
	"gpt-5":       {Input: 1.25e-6, Output: 1.0e-5, CacheRead: 1.25e-7},
	"gpt-5-codex": {Input: 1.25e-6, Output: 1.0e-5, CacheRead: 1.25e-7},
	"gpt-5-mini":  {Input: 2.5e-7, Output: 2.0e-6, CacheRead: 2.5e-8},
	"gpt-5-nano":  {Input: 5.0e-8, Output: 4.0e-7, CacheRead: 5.0e-9},
	"gpt-5-pro":   {Input: 1.5e-5, Output: 1.2e-4},

	"claude-haiku-4.5":  {Input: 1.0e-6, Output: 5.0e-6, CacheRead: 1.0e-7, CacheCreation: 1.25e-6},
	"claude-sonnet":     {Input: 3.0e-6, Output: 1.5e-5, CacheRead: 3.0e-7, CacheCreation: 3.75e-6},
	"claude-sonnet-4":   {Input: 3.0e-6, Output: 1.5e-5, CacheRead: 3.0e-7, CacheCreation: 3.75e-6},
	"claude-sonnet-4-6": {Input: 3.0e-6, Output: 1.5e-5, CacheRead: 3.0e-7, CacheCreation: 3.75e-6},
	"claude-sonnet-4.5": {Input: 3.0e-6, Output: 1.5e-5, CacheRead: 3.0e-7, CacheCreation: 3.75e-6},
	"claude-sonnet-4.6": {Input: 3.0e-6, Output: 1.5e-5, CacheRead: 3.0e-7, CacheCreation: 3.75e-6},
	"claude-opus-4":     {Input: 1.5e-5, Output: 7.5e-5, CacheRead: 1.5e-6, CacheCreation: 1.875e-5},
	"claude-opus-4.5":   {Input: 5.0e-6, Output: 2.5e-5, CacheRead: 5.0e-7, CacheCreation: 6.25e-6},
	"claude-opus-4.6":   {Input: 5.0e-6, Output: 2.5e-5, CacheRead: 5.0e-7, CacheCreation: 6.25e-6},
}

var datedSuffixRE = regexp.MustCompile(`-\d{8}$|-\d{4}-\d{2}-\d{2}$`)

// CostUSD estimates one session's usage cost. cached_tokens is treated as
// cache-read input when the provider does not expose the read/create split.
func CostUSD(model string, usage session.TokenUsage) (float64, bool) {
	r, ok := Lookup(model)
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

func Lookup(model string) (Rates, bool) {
	norm := NormalizeModel(model)
	if norm == "" {
		return Rates{}, false
	}
	if r, ok := ratesByModel[norm]; ok {
		return r, true
	}
	for key, r := range ratesByModel {
		if strings.HasPrefix(norm, key+"-") {
			return r, true
		}
	}
	return Rates{}, false
}

func NormalizeModel(model string) string {
	s := strings.ToLower(strings.TrimSpace(model))
	s = strings.TrimPrefix(s, "openai/")
	s = strings.TrimPrefix(s, "anthropic/")
	s = strings.TrimPrefix(s, "anthropic.")
	if at := strings.IndexByte(s, '@'); at >= 0 {
		s = s[:at]
	}
	return datedSuffixRE.ReplaceAllString(s, "")
}
