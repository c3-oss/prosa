package pricing

import (
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/c3-oss/prosa/pkg/session"
)

func measuredRequest(model string, input, output int64) session.RequestUsage {
	at := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	standard, global := "standard", "global"
	zero := int64(0)
	return session.RequestUsage{
		Model: model, Timestamp: &at, PromptTokens: &input,
		Usage:       session.TokenUsage{InputTokens: input, OutputTokens: output, TotalTokens: input + output},
		ServiceTier: &standard, Speed: &standard, InferenceGeo: &global,
		CacheCreation5mTokens: &zero, CacheCreation1hTokens: &zero,
	}
}

func TestRequestContextBoundaries(t *testing.T) {
	for _, tc := range []struct {
		model string
		input int64
		want  float64
	}{
		{"gpt-6.1-sol", 272000, .554},
		{"gpt-6.1-sol", 272001, 1.103004},
		{"claude-haiku-5-5", 100000, .0105},
		{"claude-haiku-5-5", 100001, .0525005},
		{"grok-4.7", 199999, .405998},
		{"grok-4.7", 200000, .812},
		{"gemini-2.5-pro", 200000, .26},
		{"gemini-2.5-pro", 200001, .5150025},
	} {
		t.Run(tc.model+"/"+strconv.FormatInt(tc.input, 10), func(t *testing.T) {
			got := RequestCost(measuredRequest(tc.model, tc.input, 1000), "", time.Time{})
			require.Equal(t, session.CostCalculated, got.Status)
			require.NotNil(t, got.USD)
			require.InDelta(t, tc.want, *got.USD, 1e-10)
		})
	}
}

func TestRequestProcessingAndCachePrices(t *testing.T) {
	for _, tc := range []struct {
		name, model, tier, speed, geo string
		input, output                 int64
		want                          float64
	}{
		{"astra fast long", "gpt-6-astra", "standard", "fast", "global", 300000, 1000, 12.15},
		{"sol ultrafast", "gpt-6.1-sol", "ultrafast", "standard", "global", 1000, 100, .018},
		{"sol batch", "gpt-6.1-sol", "batch", "standard", "global", 1000, 100, .0015},
		{"opus fast regional", "claude-opus-5-5", "standard", "fast", "us", 1000, 100, .0132},
		{"grok fast long", "grok-4.7", "standard", "fast", "global", 200000, 1000, 1.218},
		{"composer fast", "composer-2.5", "standard", "fast", "global", 1000, 100, .0045},
		{"composer explicit fast", "composer-2.5-fast", "standard", "fast", "global", 1000, 100, .0045},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := measuredRequest(tc.model, tc.input, tc.output)
			req.ServiceTier, req.Speed, req.InferenceGeo = &tc.tier, &tc.speed, &tc.geo
			got := RequestCost(req, "", time.Time{})
			require.Equal(t, session.CostCalculated, got.Status)
			require.InDelta(t, tc.want, *got.USD, 1e-10)
		})
	}

	req := measuredRequest("claude-opus-5-5", 1000, 100)
	five, hour := int64(100), int64(200)
	req.Usage.CacheReadTokens, req.Usage.CachedTokens, req.Usage.CacheCreationTokens = 400, 400, 300
	req.CacheCreation5mTokens, req.CacheCreation1hTokens = &five, &hour
	got := RequestCost(req, "", time.Time{})
	require.Equal(t, session.CostCalculated, got.Status)
	require.InDelta(t, .00538, *got.USD, 1e-10)
	req.CacheCreation1hTokens = nil
	require.Equal(t, session.CostEstimated, RequestCost(req, "", time.Time{}).Status)

	req = measuredRequest("gpt-6.1-sol", 1000, 100)
	req.Usage.CacheReadTokens, req.Usage.CachedTokens, req.Usage.CacheCreationTokens = 400, 400, 100
	got = RequestCost(req, "", time.Time{})
	require.InDelta(t, .00229, *got.USD, 1e-10)

	req = measuredRequest("claude-opus-5-5", 1000, 100)
	priority, fast := "priority", "fast"
	req.ServiceTier, req.Speed = &priority, &fast
	got = RequestCost(req, "", time.Time{})
	require.Equal(t, session.CostEstimated, got.Status)
	require.InDelta(t, .012, *got.USD, 1e-10)

	req = measuredRequest("gemini-3.5-flash-lite", 1000, 100)
	req.ServiceTier = &priority
	req.Usage.CacheReadTokens, req.Usage.CachedTokens = 400, 400
	got = RequestCost(req, "", time.Time{})
	require.InDelta(t, .000794, *got.USD, 1e-10)
}

func TestRequestHistoricalCacheAndPromotions(t *testing.T) {
	req := measuredRequest("claude-sonnet-5-5", 1000000, 0)
	req.Usage.CacheReadTokens, req.Usage.CachedTokens = 1000000, 1000000
	before := sonnet55CacheCutFrom.Add(-time.Nanosecond)
	req.Timestamp = &before
	got := RequestCost(req, "", time.Time{})
	require.InDelta(t, .2, *got.USD, 1e-10)
	req.Timestamp = &sonnet55CacheCutFrom
	got = RequestCost(req, "", time.Time{})
	require.InDelta(t, .1, *got.USD, 1e-10)

	for _, tc := range []struct {
		model string
		date  time.Time
		input float64
	}{
		{"gemini-4-argon", time.Date(2026, 11, 30, 23, 59, 59, 0, time.UTC), 2e-6},
		{"gemini-4-argon", time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC), 4e-6},
		{"gemini-3.8-flash", time.Date(2026, 12, 31, 23, 59, 59, 0, time.UTC), .75e-6},
		{"gemini-3.8-flash", time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC), 1.5e-6},
		{"gemini-3.5-flash", time.Date(2026, 10, 7, 23, 59, 59, 0, time.UTC), 1.5e-6},
		{"gemini-3.5-flash", time.Date(2026, 10, 8, 0, 0, 0, 0, time.UTC), .75e-6},
	} {
		r, ok := Lookup(tc.model, tc.date)
		require.True(t, ok)
		require.InDelta(t, tc.input, r.Input, 1e-15)
	}
	r, ok := rateAt([]ratePeriod{{Rates: Rates{Input: 1}}, {From: time.Now().AddDate(1, 0, 0), Rates: Rates{Input: 2}}}, time.Time{})
	require.True(t, ok)
	require.Equal(t, 1.0, r.Input)
}

func TestUnknownGLMSpeedIsEstimated(t *testing.T) {
	req := measuredRequest("glm-5", 1000, 100)
	unknown := "unknown"
	req.Speed = &unknown
	got := RequestCost(req, "", time.Time{})
	require.Equal(t, session.CostEstimated, got.Status)
	require.InDelta(t, .00132, *got.USD, 1e-10)
}

func TestSessionCostCoverageAndMissingData(t *testing.T) {
	model := "gpt-6.1-sol"
	a, b := measuredRequest(model, 300000, 0), measuredRequest(model, 300000, 0)
	usage := a.Usage
	usage.Add(b.Usage)
	s := session.Session{Model: &model, Usage: &usage, RequestCoverage: session.RequestCoverageComplete, Requests: []session.RequestUsage{a, b}}
	got := SessionCost(s)
	require.Equal(t, session.CostCalculated, got.Status)
	require.InDelta(t, 2.4, *got.USD, 1e-10)

	s.RequestCoverage = session.RequestCoveragePartial
	got = SessionCost(s)
	require.Equal(t, session.CostEstimated, got.Status)
	require.InDelta(t, 1.2, *got.USD, 1e-10)
	s.Usage = nil
	got = SessionCost(s)
	require.Equal(t, session.CostPartial, got.Status)
	require.InDelta(t, 2.4, *got.USD, 1e-10)

	unknown := measuredRequest("unknown", 100, 0)
	usage = a.Usage
	usage.Add(unknown.Usage)
	s.RequestCoverage, s.Usage, s.Requests = session.RequestCoverageComplete, &usage, []session.RequestUsage{a, unknown}
	got = SessionCost(s)
	require.Equal(t, session.CostPartial, got.Status)
	require.Equal(t, int64(100), got.UnpricedTokens)

	a.ServiceTier, a.Speed = nil, nil
	require.Equal(t, session.CostEstimated, RequestCost(a, "", time.Time{}).Status)
	a.PromptTokens = nil
	require.Equal(t, session.CostEstimated, RequestCost(a, "", time.Time{}).Status)
	require.Nil(t, RequestCost(measuredRequest(model, 0, 0), "", time.Time{}).USD)
	require.Nil(t, RequestCost(session.RequestUsage{Model: model, Usage: session.TokenUsage{TotalTokens: 100}}, "", time.Time{}).USD)
}

func TestZeroRequestsDoNotMakeCompleteUsagePartial(t *testing.T) {
	a := measuredRequest("claude-sonnet-5-5", 1000, 100)
	zero := measuredRequest("claude-sonnet-5-5", 0, 0)
	s := session.Session{Usage: &a.Usage, Requests: []session.RequestUsage{zero, a}, RequestCoverage: session.RequestCoverageComplete}
	got := SessionCost(s)
	require.Equal(t, session.CostCalculated, got.Status)
	require.InDelta(t, .003, *got.USD, 1e-10)
}

func TestVariantTariffsDoNotInheritFamilyPrices(t *testing.T) {
	for _, tc := range []struct {
		model                          string
		input, output, cache, creation float64
	}{
		{"gpt-6-sol", 2, 10, .2, 2.5},
		{"gpt-6.1-sol", 2, 10, .1, 2.5},
		{"gpt-6-luna", .1, .5, .01, .125},
		{"gpt-5.6-cyber", 12.5, 75, 1.25, 15.625},
		{"gpt-5.5-cyber", 12.5, 75, 1.25, 0},
		{"gpt-rosalind-research", 5, 25, .5, 0},
		{"gpt-rosalind-discovery", 5, 25, .5, 0},
		{"claude-opus-5.5-thinking", 4, 20, .2, 5},
		{"claude-sonnet-5-5", 2, 10, .1, 2.5},
		{"claude-haiku-5-5", .1, .5, .01, .125},
		{"gemini-3.1-flash-lite", .25, 1.5, .025, 0},
		{"gemini-3.5-flash-lite", .3, 2.5, .03, 0},
		{"gemini-3.6-flash", .75, 3.75, .075, 0},
		{"gemini-3.7-flash", .75, 3.75, .075, 0},
		{"gemini-3.8-flash", .75, 3.75, .075, 0},
		{"gemini-4-argon", 2, 10, .1, 0},
		{"grok-4.7-build", 2, 6, .5, 0},
		{"grok-4.3", 1.25, 2.5, .2, 0},
		{"grok-build-0.1", 1, 2, .2, 0},
		{"grok-4.20-multi-agent-0309", 1.25, 2.5, .2, 0},
		{"grok-4.20-0309-reasoning", 1.25, 2.5, .2, 0},
		{"grok-4.20-0309-non-reasoning", 1.25, 2.5, .2, 0},
		{"glm-5", 1, 3.2, .2, 0},
		{"glm-5.1", 1.4, 4.4, .26, 0},
		{"glm-5.2", 1.4, 4.4, .26, 0},
		{"glm-5.3", 1.4, 4.4, .26, 0},
		{"glm-5.3-flash", .15, .5, .03, 0},
		{"glm-5.3-flashx", .37, 1.25, .075, 0},
		{"glm-4.7-flash", 0, 0, 0, 0},
		{"glm-4.7-flashx", .07, .4, .01, 0},
		{"composer-2.5-fast", 3, 15, .5, 0},
	} {
		t.Run(tc.model, func(t *testing.T) {
			r, ok := Lookup(tc.model, time.Date(2026, 10, 14, 0, 0, 0, 0, time.UTC))
			require.True(t, ok)
			require.InDelta(t, tc.input, r.Input*1e6, 1e-10)
			require.InDelta(t, tc.output, r.Output*1e6, 1e-10)
			require.InDelta(t, tc.cache, r.CacheRead*1e6, 1e-10)
			require.InDelta(t, tc.creation, r.CacheCreation*1e6, 1e-10)
		})
	}
	free := RequestCost(measuredRequest("glm-4.7-flash", 1000, 100), "", time.Time{})
	require.NotNil(t, free.USD)
	require.Zero(t, *free.USD)
}

func TestCombineCostsIgnoresUnmeasuredMembers(t *testing.T) {
	usd := 1.25
	got := CombineCosts(
		session.CostSummary{USD: &usd, Status: session.CostCalculated, PricedTokens: 1000},
		session.CostSummary{Status: session.CostUnavailable},
	)
	require.Equal(t, session.CostCalculated, got.Status)
	require.InDelta(t, 1.25, *got.USD, 1e-10)

	got = CombineCosts(
		session.CostSummary{USD: &usd, Status: session.CostCalculated, PricedTokens: 1000},
		session.CostSummary{Status: session.CostUnavailable, UnpricedTokens: 100},
	)
	require.Equal(t, session.CostPartial, got.Status)
	require.Equal(t, int64(100), got.UnpricedTokens)
}

func TestRequestCostNormalisesInferenceGeoCase(t *testing.T) {
	for _, model := range []string{"gemini-3.5-flash", "gpt-6-astra"} {
		req := measuredRequest(model, 1000, 100)
		geo := "Global"
		req.InferenceGeo = &geo
		require.Equal(t, session.CostCalculated, RequestCost(req, "", time.Time{}).Status, model)
	}
}
