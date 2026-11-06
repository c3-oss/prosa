package session

import "time"

const (
	RequestCoverageNone     = "none"
	RequestCoveragePartial  = "partial"
	RequestCoverageComplete = "complete"
	CostCalculated          = "calculated"
	CostEstimated           = "estimated"
	CostPartial             = "partial"
	CostUnavailable         = "unavailable"
)

// RequestUsage describes one measured inference, including server-side iterations.
type RequestUsage struct {
	ID                    string
	Model                 string
	Timestamp             *time.Time
	Usage                 TokenUsage
	PromptTokens          *int64
	Provider              *string
	ServiceTier           *string
	Speed                 *string
	InferenceGeo          *string
	CacheCreation5mTokens *int64
	CacheCreation1hTokens *int64
}

// CostSummary describes token charges and the usage that could be priced.
type CostSummary struct {
	USD            *float64
	Status         string
	PricedTokens   int64
	UnpricedTokens int64
}

func (u *TokenUsage) Add(v TokenUsage) {
	u.TotalTokens += v.TotalTokens
	u.InputTokens += v.InputTokens
	u.OutputTokens += v.OutputTokens
	u.CachedTokens += v.CachedTokens
	u.CacheReadTokens += v.CacheReadTokens
	u.CacheCreationTokens += v.CacheCreationTokens
}
