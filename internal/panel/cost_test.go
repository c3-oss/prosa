package panel

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"testing"

	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/pkg/session"
	"github.com/stretchr/testify/require"
)

func TestSessionSummaryAuthoritativeAndLegacyFallback(t *testing.T) {
	usd := 12.34
	s := pricedPanelSession("parent", "prompt", 1000)
	s.Cost = &prosav1.CostSummary{Usd: &usd, Status: session.CostCalculated, PricedTokens: 1000}
	require.Equal(t, "$12.34", costSummaryLabel(sessionCostSummary(s)))
	s.Cost = &prosav1.CostSummary{Status: session.CostUnavailable, UnpricedTokens: 1000}
	require.Equal(t, "n/a", costSummaryLabel(sessionCostSummary(s)))
	s.Cost = nil
	require.Equal(t, session.CostEstimated, sessionCostSummary(s).Status)
	require.Contains(t, costSummaryLabel(sessionCostSummary(s)), "~$")
}

func TestRollupSessionCostPreservesQuality(t *testing.T) {
	usd := 1.0
	parent := pricedPanelSession("parent", "prompt", 1000)
	parent.Cost = &prosav1.CostSummary{Usd: &usd, Status: session.CostCalculated, PricedTokens: 1000}
	child := unpricedPanelSession("child", "prompt")
	child.Cost = &prosav1.CostSummary{Status: session.CostUnavailable, UnpricedTokens: 1000}
	row := buildSessionRow(parent, &url.URL{Path: "/sessions"}, nil)
	row.Children = []sessionRow{buildSessionRow(child, &url.URL{Path: "/sessions"}, nil)}
	rollUpSessionRowCost(&row)
	require.Equal(t, "$1.00 (partial)", row.Cost)
	require.Equal(t, int64(1000), row.costSummary.UnpricedTokens)
	child.Cost = &prosav1.CostSummary{Usd: &usd, Status: session.CostEstimated, PricedTokens: 1000}
	row = buildSessionRow(parent, &url.URL{Path: "/sessions"}, nil)
	row.Children = []sessionRow{buildSessionRow(child, &url.URL{Path: "/sessions"}, nil)}
	rollUpSessionRowCost(&row)
	require.Equal(t, "~$2.00", row.Cost)
}

func TestCostSortPricesEveryBatchBeforePaging(t *testing.T) {
	var all []*prosav1.Session
	for i := range 1205 {
		usd := float64(i)
		all = append(all, &prosav1.Session{Id: fmt.Sprintf("session-%04d", i), Cost: &prosav1.CostSummary{Usd: &usd, Status: session.CostCalculated}})
	}
	var offsets []int32
	p := newPanelWithFakeSessions(t, fakeSessionsService{listPage: func(req *prosav1.ListRequest) *prosav1.ListResponse {
		offsets = append(offsets, req.Offset)
		end := min(int(req.Offset+req.Limit), len(all))
		return &prosav1.ListResponse{Sessions: all[int(req.Offset):end], TotalCount: int64(len(all))}
	}})
	got, total, pages, err := p.listSessionsSortedByCost(context.Background(), &prosav1.ListRequest{}, 2, 10, "desc")
	require.NoError(t, err)
	require.Equal(t, []int32{0, 1000}, offsets)
	require.Equal(t, int64(1205), total)
	require.Equal(t, 121, pages)
	require.Len(t, got, 10)
	require.Equal(t, "session-1194", got[0].Id)
	require.Equal(t, "session-1185", got[9].Id)
}

func TestCostSortChildFailureIsReturnedAndTiesUseID(t *testing.T) {
	usd := 1.0
	rows := []*prosav1.Session{{Id: "b", Cost: &prosav1.CostSummary{Usd: &usd, Status: session.CostCalculated}}, {Id: "a", Cost: &prosav1.CostSummary{Usd: &usd, Status: session.CostCalculated}}}
	p := newPanelWithFakeSessions(t, fakeSessionsService{listResponse: &prosav1.ListResponse{Sessions: rows, TotalCount: 2}, childrenErr: errors.New("child lookup failed")})
	_, _, _, err := p.listSessionsSortedByCost(context.Background(), &prosav1.ListRequest{TopLevelOnly: true}, 1, 10, "desc")
	require.ErrorContains(t, err, "child lookup failed")
	got, _, _, err := p.listSessionsSortedByCost(context.Background(), &prosav1.ListRequest{}, 1, 10, "desc")
	require.NoError(t, err)
	require.Equal(t, []string{"a", "b"}, panelSessionIDs(got))
}

func TestReportsUseServerCostAndCoverage(t *testing.T) {
	trend := buildSpendTrend([]*prosav1.AnalyticsRow{
		aRow("2026-10-14", "mystery-model", "1", "1", "1000", "1000", "0", "0", "0", "0", "1.25", "calculated", "1000", "0"),
	}, pricingTimeFromDay("2026-10-14"), pricingTimeFromDay("2026-10-15"))
	require.Equal(t, "$1.25", trend.TotalSpend)
	profiles := buildProfileUsage([]*prosav1.AnalyticsRow{
		aRow("2026-10-14", "Laptop", "codex", "default", "mystery-model", "1", "1", "1000", "1000", "0", "0", "0", "0", "2026-10-14 12:00", "0", "calculated", "1000", "0"),
	})
	require.Equal(t, "$0.00", profiles.TotalSpend)
	require.Equal(t, "$0.00", profiles.ProfileBars[0].Cost)
	require.Equal(t, "$0.00", profiles.Rows[0].Cost)
	costs := usageReportCost([]*prosav1.AnalyticsRow{
		aRow("codex", "1", "1", "1000", "1000", "0", "0", "1.25", "calculated", "1000", "0"),
		aRow("hermes", "1", "1", "100", "100", "0", "0", "", "unavailable", "0", "100"),
	})
	require.Equal(t, "$1.25 (partial)", costSummaryLabel(costs))
}

func TestAuthoritativeUnmeasuredReportRowsKeepCostCoverage(t *testing.T) {
	trend := buildSpendTrend([]*prosav1.AnalyticsRow{
		aRow("2026-10-14", "model", "1", "0", "1000", "1000", "0", "0", "0", "0", "1.25", "calculated", "1000", "0"),
		aRow("2026-10-14", "unknown", "1", "0", "100", "100", "0", "0", "0", "0", "", "unavailable", "0", "100"),
	}, pricingTimeFromDay("2026-10-14"), pricingTimeFromDay("2026-10-15"))
	require.Equal(t, "$1.25 (partial)", trend.TotalSpend)
	delegation := buildDelegationKPIs([]*prosav1.AnalyticsRow{
		aRow("2026-10-14", "subagent", "model", "1", "0", "1000", "1000", "0", "0", "0", "0", "1.25", "calculated", "1000", "0"),
		aRow("2026-10-14", "subagent", "unknown", "1", "0", "100", "100", "0", "0", "0", "0", "", "unavailable", "0", "100"),
	}, nil)
	require.Equal(t, "$1.25 (partial)", delegation.SubagentSpend)
	profiles := buildProfileUsage([]*prosav1.AnalyticsRow{
		aRow("2026-10-14", "Laptop", "codex", "default", "model", "1", "0", "1000", "1000", "0", "0", "0", "0", "2026-10-14 12:00", "1.25", "calculated", "1000", "0"),
		aRow("2026-10-14", "Laptop", "codex", "default", "unknown", "1", "0", "100", "100", "0", "0", "0", "0", "2026-10-14 12:00", "", "unavailable", "0", "100"),
	})
	require.Equal(t, "$1.25 (partial)", profiles.TotalSpend)
	require.Equal(t, "$1.25 (partial)", profiles.Rows[0].Cost)
}

func TestSidePanelRendersCostQualityMarkers(t *testing.T) {
	usd := 1.25
	views, err := loadViews()
	require.NoError(t, err)
	for _, tc := range []struct{ status, label string }{
		{session.CostCalculated, "$1.25"},
		{session.CostEstimated, "~$1.25"},
		{session.CostPartial, "$1.25 (partial)"},
		{session.CostUnavailable, "n/a"},
	} {
		t.Run(tc.status, func(t *testing.T) {
			source := &prosav1.Session{
				Id: tc.status, Agent: "codex", FirstPrompt: "session prompt",
				StartedAt: timestamppb.New(pricingTimeFromDay("2026-10-14")), LastActivityAt: timestamppb.New(pricingTimeFromDay("2026-10-14")),
				Cost: &prosav1.CostSummary{Usd: &usd, Status: tc.status},
			}
			if tc.status == session.CostUnavailable {
				source.Cost.Usd = nil
			}
			data := sidePanelData{Session: source, Cost: costSummaryLabel(sessionCostSummary(source))}
			var out bytes.Buffer
			require.NoError(t, views["side_panel"].ExecuteTemplate(&out, "side_panel_body", data))
			require.Contains(t, out.String(), `<div class="stat-value">`+tc.label+`</div>`)
		})
	}
}
