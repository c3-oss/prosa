package panel

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
)

func aRow(vals ...string) *prosav1.AnalyticsRow {
	return &prosav1.AnalyticsRow{Values: vals}
}

func TestBuildProjectBarsAggregatesAcrossAgents(t *testing.T) {
	t.Parallel()
	rows := []*prosav1.AnalyticsRow{
		aRow("proj-a", "claude-code", "3"),
		aRow("proj-a", "codex", "2"),
		aRow("proj-b", "claude-code", "4"),
	}
	bars := buildProjectBars(rows, 10)
	require.Len(t, bars, 2)
	require.Equal(t, "proj-a", bars[0].Label) // 5 = 3+2, ranks first
	require.Equal(t, "5", bars[0].Count)
	require.Equal(t, "proj-b", bars[1].Label)
	require.Equal(t, "4", bars[1].Count)
}

func TestBuildModelUsageTokensCostAndLegend(t *testing.T) {
	t.Parallel()
	rows := []*prosav1.AnalyticsRow{
		aRow("claude-opus-4-5", "2", "1500", "1200", "300", "0.1200"),
		aRow("gpt-5-codex", "1", "300", "200", "100", ""), // unpriced
	}
	mv := buildModelUsage(rows)
	require.Len(t, mv.TokenBars, 2)
	require.Equal(t, "claude-opus-4-5", mv.TokenBars[0].Label)
	require.Equal(t, "1.5k", mv.TokenBars[0].Count) // compact token formatting
	require.Equal(t, "1,800", mv.TotalTokens)
	require.Equal(t, "$0.12", mv.TotalCost)
	require.Len(t, mv.CostLegend, 1) // only the priced model
	require.Equal(t, "claude-opus-4-5", mv.CostLegend[0].Model)
	require.Equal(t, "$0.12", mv.CostLegend[0].Cost)
	require.Contains(t, string(mv.CostDonut), "<svg")
}

func TestBuildModelUsageNoCostIsNA(t *testing.T) {
	t.Parallel()
	mv := buildModelUsage([]*prosav1.AnalyticsRow{aRow("mystery-model", "1", "500", "400", "100", "")})
	require.Equal(t, "n/a", mv.TotalCost)
	require.Empty(t, mv.CostLegend)
}

func TestBuildIssuesRateAndRecent(t *testing.T) {
	t.Parallel()
	errModel := []*prosav1.AnalyticsRow{
		aRow("claude-opus-4-5", "3"),
		aRow("gpt-5-codex", "1"),
	}
	errRows := []*prosav1.AnalyticsRow{
		aRow("2026-05-30 09:00", "claude-code", "proj-a", "s1"),
		aRow("2026-05-30 10:00", "codex", "proj-b", "s2"),
	}
	iv := buildIssues(errModel, errRows, 20)
	require.Equal(t, int64(4), iv.Flagged)
	require.Equal(t, "20%", iv.Rate)
	require.Equal(t, "claude-opus-4-5", iv.TopModel) // highest flagged count
	require.Len(t, iv.PerModelBars, 2)
	require.Len(t, iv.Recent, 2)
	require.Equal(t, "/sessions?session=s1", iv.Recent[0].URL)
	require.Equal(t, "2026-05-30 09:00", iv.Recent[0].When)
	require.Contains(t, string(iv.Recent[0].Agent), `data-agent="claude-code"`)
	require.Contains(t, string(iv.Recent[0].Project), "proj-a")
}

func TestBuildIssuesZeroSessions(t *testing.T) {
	t.Parallel()
	iv := buildIssues(nil, nil, 0)
	require.Equal(t, int64(0), iv.Flagged)
	require.Equal(t, "0%", iv.Rate)
	require.Equal(t, "—", iv.TopModel)
	require.Empty(t, iv.Recent)
}

func TestBuildHourChartRotatesToLocalOffset(t *testing.T) {
	t.Parallel()
	rows := []*prosav1.AnalyticsRow{aRow("09", "2"), aRow("14", "1")}

	// UTC (offset 0): peak stays at 09h.
	utc := buildHourChartTZ(rows, 0)
	require.Equal(t, "peak 09h local", utc.PeakLabel)
	require.Contains(t, string(utc.Chart), "09h: 2 sessions")

	// America/Sao_Paulo style (offset -3): 09 UTC → 06 local.
	br := buildHourChartTZ(rows, -3)
	require.Equal(t, "peak 06h local", br.PeakLabel)
	require.Contains(t, string(br.Chart), "06h: 2 sessions")

	// Wrap across midnight (offset +5): 14 + 5 = 19; 09 + 5 = 14 (peak still 14 local, value 2).
	ist := buildHourChartTZ(rows, 5)
	require.Equal(t, "peak 14h local", ist.PeakLabel)
}

func TestBuildHourChartEmpty(t *testing.T) {
	t.Parallel()
	hv := buildHourChartTZ(nil, 0)
	require.Equal(t, "no activity", hv.PeakLabel)
	require.Contains(t, string(hv.Chart), "<svg")
}

func TestBuildKPIDelta(t *testing.T) {
	t.Parallel()
	require.Nil(t, buildKPIDelta(0, 0, deltaUpGood), "both zero → no badge")

	d := buildKPIDelta(5, 0, deltaUpGood)
	require.Equal(t, "new", d.Text)
	require.Equal(t, "good", d.Tone)

	d = buildKPIDelta(112, 100, deltaUpGood)
	require.Equal(t, "+12%", d.Text)
	require.Equal(t, "up", d.Dir)
	require.Equal(t, "good", d.Tone)

	d = buildKPIDelta(80, 100, deltaUpGood)
	require.Equal(t, "-20%", d.Text)
	require.Equal(t, "down", d.Dir)
	require.Equal(t, "bad", d.Tone)

	// Error rate inverts: rising is bad, falling is good.
	d = buildKPIDelta(20, 10, deltaUpBad)
	require.Equal(t, "+100%", d.Text)
	require.Equal(t, "bad", d.Tone)
	d = buildKPIDelta(5, 10, deltaUpBad)
	require.Equal(t, "good", d.Tone)

	// Spend is informational either way.
	d = buildKPIDelta(20, 10, deltaNeutral)
	require.Equal(t, "muted", d.Tone)
	d = buildKPIDelta(5, 10, deltaNeutral)
	require.Equal(t, "muted", d.Tone)

	// Sub-half-percent movements flatten to 0%.
	d = buildKPIDelta(1001, 1000, deltaUpGood)
	require.Equal(t, "+0%", d.Text)
	require.Equal(t, "flat", d.Dir)
	require.Equal(t, "muted", d.Tone)
}

func TestBuildActivityTrendStacksByAgent(t *testing.T) {
	t.Parallel()
	rows := []*prosav1.AnalyticsRow{
		aRow("2026-05-30", "claude-code", "3"),
		aRow("2026-05-30", "codex", "1"),
		aRow("2026-05-31", "", "0"), // zero-filled day keeps the axis continuous
		aRow("2026-06-01", "claude-code", "2"),
	}
	v := buildActivityTrend(rows)
	require.True(t, v.HasData)
	require.Equal(t, int64(6), v.Total)
	require.Equal(t, "per day", v.BucketLabel)
	require.Equal(t, "05-30", v.StartLabel)
	require.Equal(t, "06-01", v.EndLabel)
	require.Len(t, v.Legend, 2)
	require.Equal(t, "claude-code", v.Legend[0].Model) // highest volume first
	require.Equal(t, "5", v.Legend[0].Sessions)
	require.Contains(t, string(v.Chart), "stacked-chart")
}

func TestBuildActivityTrendCollapsesLongWindowsToWeeks(t *testing.T) {
	t.Parallel()
	rows := make([]*prosav1.AnalyticsRow, 0, 200)
	day := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := range 200 {
		rows = append(rows, aRow(day.AddDate(0, 0, i).Format("2006-01-02"), "claude-code", "1"))
	}
	v := buildActivityTrend(rows)
	require.Equal(t, "per week", v.BucketLabel)
	require.Equal(t, int64(200), v.Total)
}

func TestBuildActivityTrendEmpty(t *testing.T) {
	t.Parallel()
	v := buildActivityTrend(nil)
	require.False(t, v.HasData)
}
