package panel

import (
	"strconv"
	"strings"
	"time"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/pricing"
	"github.com/c3-oss/prosa/pkg/session"
)

func sessionCostSummary(s *prosav1.Session) session.CostSummary {
	if s == nil {
		return session.CostSummary{Status: session.CostUnavailable}
	}
	if s.Cost != nil {
		return session.CostSummary{USD: s.Cost.Usd, Status: s.Cost.Status, PricedTokens: s.Cost.PricedTokens, UnpricedTokens: s.Cost.UnpricedTokens}
	}
	usage := tokenUsageFromProto(s.Usage)
	model := s.Model
	return pricing.SessionCost(session.Session{Model: &model, Usage: &usage, StartedAt: sessionStartedAt(s)})
}

func costSummaryLabel(cost session.CostSummary) string {
	if cost.USD == nil {
		return "n/a"
	}
	label := formatUSD(*cost.USD)
	switch cost.Status {
	case session.CostEstimated:
		return "~" + label
	case session.CostPartial:
		return label + " (partial)"
	}
	return label
}

func reportCost(values []string, index int, totalTokens int64) session.CostSummary {
	out := session.CostSummary{Status: session.CostUnavailable, UnpricedTokens: totalTokens}
	if index >= len(values) {
		return out
	}
	if value, err := strconv.ParseFloat(strings.TrimSpace(values[index]), 64); err == nil {
		out.USD = &value
		out.Status = session.CostEstimated
		out.PricedTokens = totalTokens
		out.UnpricedTokens = 0
	}
	if len(values) >= index+4 {
		out.Status = values[index+1]
		out.PricedTokens = parsePanelInt(values[index+2])
		out.UnpricedTokens = parsePanelInt(values[index+3])
	}
	return out
}

func reportTailCost(values []string, baseColumns int, model string, usage session.TokenUsage, startedAt time.Time) session.CostSummary {
	if len(values) >= baseColumns+4 {
		return reportCost(values, len(values)-4, usage.TotalTokens)
	}
	return pricing.SessionCost(session.Session{Model: &model, Usage: &usage, StartedAt: startedAt})
}

func usageReportCost(rows []*prosav1.AnalyticsRow) session.CostSummary {
	costs := make([]session.CostSummary, 0, len(rows))
	for _, row := range rows {
		if len(row.Values) >= 8 {
			costs = append(costs, reportCost(row.Values, 7, parsePanelInt(row.Values[3])))
		}
	}
	return pricing.CombineCosts(costs...)
}
