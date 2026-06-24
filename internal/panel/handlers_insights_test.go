package panel

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
)

func TestBuildPunchcardTZRotatesWithDayCarry(t *testing.T) {
	t.Parallel()
	// Sunday 01:00 UTC at offset -3 lands on Saturday 22:00 local.
	_, grid := buildPunchcardTZ([]*prosav1.AnalyticsRow{aRow("0", "01", "2")}, -3)
	require.Equal(t, int64(2), grid[6][22])
	require.Equal(t, int64(0), grid[0][1])

	// Saturday 23:00 UTC at offset +5 lands on Sunday 04:00 local.
	_, grid = buildPunchcardTZ([]*prosav1.AnalyticsRow{aRow("6", "23", "1")}, 5)
	require.Equal(t, int64(1), grid[0][4])

	_, grid = buildPunchcardTZ([]*prosav1.AnalyticsRow{aRow("2", "14", "7")}, 0)
	require.Equal(t, int64(7), grid[2][14])
}

func TestBuildPunchcardLevelsAndLabels(t *testing.T) {
	t.Parallel()
	view, _ := buildPunchcardTZ([]*prosav1.AnalyticsRow{
		aRow("1", "09", "8"),
		aRow("1", "10", "1"),
	}, 0)
	require.Equal(t, int64(9), view.Total)
	mon := view.Rows[1]
	require.Equal(t, "Mon", mon.Label)
	require.Equal(t, 4, mon.Cells[9].Level)
	require.Equal(t, 1, mon.Cells[10].Level)
	require.Equal(t, 0, mon.Cells[11].Level)
	require.Equal(t, "Mon 09h: 8 sessions", mon.Cells[9].Label)
}

func TestBuildScheduleKPIs(t *testing.T) {
	t.Parallel()
	var grid punchcardGrid
	grid[0][10] = 2 // Sunday in-hours (weekend)
	grid[2][10] = 2 // Tuesday in-hours
	grid[2][20] = 1 // Tuesday off-hours
	s := buildScheduleKPIs(grid)
	require.True(t, s.HasData)
	require.Equal(t, "40%", s.WeekendPct)  // 2 of 5
	require.Equal(t, "20%", s.OffHoursPct) // 1 of 5
	require.Equal(t, "Tuesday", s.BusiestDay)
}

func TestBuildScheduleKPIsEmpty(t *testing.T) {
	t.Parallel()
	s := buildScheduleKPIs(punchcardGrid{})
	require.False(t, s.HasData)
	require.Equal(t, "—", s.WeekendPct)
	require.Equal(t, "—", s.BusiestDay)
}

func TestBuildStreaks(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 6, 9, 15, 0, 0, 0, time.UTC)
	trailing := []*prosav1.AnalyticsRow{
		aRow("2026-06-04", "claude-code", "1"),
		aRow("2026-06-05", "claude-code", "2"),
		aRow("2026-06-06", "", "0"),
		aRow("2026-06-07", "claude-code", "1"),
		aRow("2026-06-08", "codex", "1"),
		aRow("2026-06-09", "claude-code", "3"),
	}
	window := []*prosav1.AnalyticsRow{
		aRow("2026-06-05", "claude-code", "2"),
		aRow("2026-06-06", "", "0"),
		aRow("2026-06-07", "claude-code", "1"),
		aRow("2026-06-08", "codex", "1"),
		aRow("2026-06-09", "claude-code", "3"),
	}
	s := buildStreaks(trailing, window, now)
	require.Equal(t, "3 days", s.Current) // 06-07..06-09
	require.Equal(t, "3 days", s.Longest)
	require.Equal(t, "80%", s.ActivePct) // 4 of 5
	require.Equal(t, "4 / 5 days", s.ActiveDays)
}

func TestBuildStreaksQuietTodayFallsBackToYesterday(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 6, 9, 8, 0, 0, 0, time.UTC)
	trailing := []*prosav1.AnalyticsRow{
		aRow("2026-06-07", "claude-code", "1"),
		aRow("2026-06-08", "claude-code", "1"),
		aRow("2026-06-09", "", "0"), // nothing yet today
	}
	s := buildStreaks(trailing, trailing, now)
	require.Equal(t, "2 days", s.Current)
}

func TestBuildDurationsKeepsCanonicalOrder(t *testing.T) {
	t.Parallel()
	buckets := []*prosav1.AnalyticsRow{
		aRow(">2h", "1"),
		aRow("<5m", "4"),
		aRow("1-2h", "2"),
	}
	stats := []*prosav1.AnalyticsRow{aRow("600", "8640", "3408", "10800")}
	d := buildDurations(buckets, stats)
	require.True(t, d.HasData)
	require.Len(t, d.Bars, 6)
	require.Equal(t, "<5m", d.Bars[0].Label) // canonical order, not count order
	require.Equal(t, "4", d.Bars[0].Count)
	require.Equal(t, 100, d.Bars[0].Percent)
	require.Equal(t, "5-15m", d.Bars[1].Label)
	require.Equal(t, 0, d.Bars[1].Percent) // zero bucket still listed
	require.Equal(t, ">2h", d.Bars[5].Label)
	require.Equal(t, "10m", d.Median)
	require.Equal(t, "2h 24m", d.P90)
	require.Equal(t, "56m", d.Avg)
	require.Equal(t, "3h", d.Longest)
}

func TestBuildDurationsEmpty(t *testing.T) {
	t.Parallel()
	d := buildDurations(nil, nil)
	require.False(t, d.HasData)
	require.Equal(t, "—", d.Median)
	require.Equal(t, "—", d.Longest)
}

func TestBuildSpendTrendPricesOnlyMeasuredRows(t *testing.T) {
	t.Parallel()
	since := time.Date(2026, 5, 29, 0, 0, 0, 0, time.UTC)
	until := time.Date(2026, 5, 31, 12, 0, 0, 0, time.UTC)
	rows := []*prosav1.AnalyticsRow{
		// Priced: claude-opus-4-5 at 1M input + 100k output = $5.00 + $2.50.
		aRow("2026-05-30", "claude-opus-4-5", "2", "2", "1100000", "1000000", "100000", "0", "0", "0"),
		// Measured but unknown model → tokens counted, no spend.
		aRow("2026-05-30", "mystery-model", "1", "1", "500", "400", "100", "0", "0", "0"),
		// Known model but zero measured sessions → not priced.
		aRow("2026-05-31", "claude-opus-4-5", "1", "0", "0", "0", "0", "0", "0", "0"),
	}
	v := buildSpendTrend(rows, since, until)
	require.True(t, v.HasData)
	require.Equal(t, "$7.50", v.TotalSpend)
	require.Equal(t, "1.1m", v.TotalTokens)
	require.Equal(t, "per day", v.BucketLabel)
	require.Equal(t, "05-29", v.StartLabel)
	require.Equal(t, "05-31", v.EndLabel)
	require.Equal(t, "bar", v.SpendChart.Type)
	require.Equal(t, "$", v.SpendChart.ValuePrefix)
	require.Contains(t, v.SpendChart.Datasets[0].Values, 7.5) // the priced day
	require.Equal(t, "line", v.TokensChart.Type)
	require.True(t, v.TokensChart.RegionFill)
}

func TestBuildSpendTrendUnpricedIsNA(t *testing.T) {
	t.Parallel()
	since := time.Date(2026, 5, 30, 0, 0, 0, 0, time.UTC)
	v := buildSpendTrend([]*prosav1.AnalyticsRow{
		aRow("2026-05-30", "mystery-model", "1", "1", "500", "400", "100", "0", "0", "0"),
	}, since, since)
	require.Equal(t, "n/a", v.TotalSpend)
	require.Equal(t, "500", v.TotalTokens)
}

func TestBuildSpendTrendWeeklyCutover(t *testing.T) {
	t.Parallel()
	until := time.Date(2026, 6, 9, 0, 0, 0, 0, time.UTC)
	since := until.AddDate(0, 0, -200)
	v := buildSpendTrend(nil, since, until)
	require.Equal(t, "per week", v.BucketLabel)
	require.False(t, v.HasData)
}

func TestBuildModelShareTopNPlusOther(t *testing.T) {
	t.Parallel()
	rows := []*prosav1.AnalyticsRow{
		aRow("2026-05-25", "model-a", "10"),
		aRow("2026-05-26", "model-b", "8"),
		aRow("2026-06-01", "model-c", "6"),
		aRow("2026-06-02", "model-d", "4"),
		aRow("2026-06-03", "model-e", "2"),
		aRow("2026-06-04", "model-f", "1"),
	}
	v := buildModelShare(rows)
	require.True(t, v.HasData)
	require.Len(t, v.Legend, modelShareTopN+1)
	require.Equal(t, "model-a", v.Legend[0].Model)
	require.Equal(t, "other", v.Legend[modelShareTopN].Model)
	require.Equal(t, "3", v.Legend[modelShareTopN].Sessions) // model-e + model-f
	// 05-25 and 05-26 share an ISO week (Monday 05-25).
	require.Equal(t, "05-25", v.StartLabel)
	require.Equal(t, "06-01", v.EndLabel)
	require.Equal(t, "bar", v.Chart.Type)
	require.True(t, v.Chart.Stacked)
	require.Equal(t, "%", v.Chart.ValueSuffix)
	for w := range v.Chart.Labels {
		var sum float64
		for _, d := range v.Chart.Datasets {
			sum += d.Values[w]
		}
		require.True(t, sum == 0 || (sum > 99.9 && sum < 100.1), "column %d sums to %v", w, sum)
	}
}

func TestBuildModelShareEmpty(t *testing.T) {
	t.Parallel()
	v := buildModelShare(nil)
	require.False(t, v.HasData)
}

func TestBuildSubagentsTotals(t *testing.T) {
	t.Parallel()
	v := buildSubagents([]*prosav1.AnalyticsRow{
		aRow("claude-code", "2", "5", "3"),
		aRow("codex", "1", "2", "2"),
	})
	require.True(t, v.HasData)
	require.Equal(t, "3", v.Parents)
	require.Equal(t, "7", v.Children)
	require.Equal(t, "3", v.MaxFan)
	require.Len(t, v.Rows, 2)
	require.Contains(t, string(v.Rows[0].Agent), "claude-code")
}

func TestBuildDaySpan(t *testing.T) {
	t.Parallel()
	days := buildDaySpan(
		time.Date(2026, 5, 30, 18, 0, 0, 0, time.UTC),
		time.Date(2026, 6, 2, 3, 0, 0, 0, time.UTC),
	)
	require.Equal(t, []string{"2026-05-30", "2026-05-31", "2026-06-01", "2026-06-02"}, days)
}

func TestBuildDelegationKPIs(t *testing.T) {
	t.Parallel()
	usage := []*prosav1.AnalyticsRow{
		aRow("2026-05-30", "direct", "claude-opus-4-5", "2", "2", "1500", "1200", "300", "0", "0", "0"),
		aRow("2026-05-30", "subagent", "claude-opus-4-5", "2", "2", "500", "400", "100", "0", "0", "0"),
	}
	parents := []*prosav1.AnalyticsRow{
		aRow("2026-05-30 09:00", "claude-code", "(unscoped)", "p1", "2"),
		aRow("2026-05-30 11:00", "claude-code", "(unscoped)", "p2", "5"),
	}
	v := buildDelegationKPIs(usage, parents)
	require.True(t, v.HasData)
	require.Equal(t, "2", v.Spawning)
	require.Equal(t, "7", v.Children)
	require.Equal(t, "25%", v.DelegatedPct) // 500 of 2000 tokens
	require.Equal(t, "5", v.MaxFan)
	require.NotEqual(t, "n/a", v.SubagentSpend) // opus is a priced model

	// Unknown model → tokens count but spend stays honest.
	unpriced := buildDelegationKPIs([]*prosav1.AnalyticsRow{
		aRow("2026-05-30", "subagent", "some-local-model", "1", "1", "500", "400", "100", "0", "0", "0"),
	}, nil)
	require.Equal(t, "n/a", unpriced.SubagentSpend)
	require.Equal(t, "100%", unpriced.DelegatedPct)

	empty := buildDelegationKPIs(nil, nil)
	require.False(t, empty.HasData)
	require.Equal(t, "—", empty.DelegatedPct)
}

func TestBuildDelegationTrendWeeklyShare(t *testing.T) {
	t.Parallel()
	// Two ISO weeks: 2026-05-25 (Mon) and 2026-06-01 (Mon).
	rows := []*prosav1.AnalyticsRow{
		aRow("2026-05-30", "direct", "m", "1", "1", "900", "0", "0", "0", "0", "0"),
		aRow("2026-05-30", "subagent", "m", "1", "1", "100", "0", "0", "0", "0", "0"),
		aRow("2026-06-02", "direct", "m", "1", "1", "500", "0", "0", "0", "0", "0"),
		aRow("2026-06-02", "subagent", "m", "1", "1", "500", "0", "0", "0", "0", "0"),
	}
	v := buildDelegationTrend(rows)
	require.True(t, v.HasData)
	require.Equal(t, []string{"05-25", "06-01"}, v.Chart.Labels)
	require.Equal(t, []float64{10, 50}, v.Chart.Datasets[0].Values)

	// No subagent tokens at all → empty card, not a flat zero line.
	flat := buildDelegationTrend(rows[:1])
	require.False(t, flat.HasData)
}

func TestBuildFanoutBuckets(t *testing.T) {
	t.Parallel()
	mk := func(id string, children string) *prosav1.AnalyticsRow {
		return aRow("2026-05-30 09:00", "claude-code", "(unscoped)", id, children)
	}
	v := buildFanoutHistogram([]*prosav1.AnalyticsRow{
		mk("a", "1"), mk("b", "1"), mk("c", "2"), mk("d", "4"), mk("e", "8"), mk("f", "30"),
	})
	require.True(t, v.HasData)
	labels := make([]string, 0, len(v.Bars))
	counts := map[string]string{}
	for _, b := range v.Bars {
		labels = append(labels, b.Label)
		counts[b.Label] = b.Count
	}
	require.Equal(t, fanoutBuckets, labels) // canonical order, all buckets present
	require.Equal(t, "2", counts["1"])
	require.Equal(t, "1", counts["2"])
	require.Equal(t, "1", counts["3-4"])
	require.Equal(t, "1", counts["5-8"])
	require.Equal(t, "1", counts["9+"])

	require.False(t, buildFanoutHistogram(nil).HasData)
}

func TestBuildTopDelegatorsLinksAndCap(t *testing.T) {
	t.Parallel()
	rows := make([]*prosav1.AnalyticsRow, 0, 10)
	for i := range 10 {
		rows = append(rows, aRow("2026-05-30 09:00", "claude-code", "(unscoped)", string(rune('a'+i)), "3"))
	}
	out := buildTopDelegators(rows, 8)
	require.Len(t, out, 8)
	require.Equal(t, "/sessions?session=a", out[0].URL)
	require.Equal(t, "3", out[0].Children)
	require.Contains(t, string(out[0].Agent), "claude-code")
}

func TestBuildDayByModelRotation(t *testing.T) {
	t.Parallel()
	rows := []*prosav1.AnalyticsRow{
		aRow("01", "model-a", "3", "3", "900", "0", "0", "0", "0", "0"),
		aRow("01", "model-b", "1", "1", "100", "0", "0", "0", "0", "0"),
		aRow("23", "model-a", "1", "1", "200", "0", "0", "0", "0", "0"),
	}
	// Offset -3: 01h UTC → 22h local; 23h UTC → 20h local.
	v := buildDayByModelTZ(rows, -3)
	require.True(t, v.HasData)
	require.Equal(t, "peak 22h local", v.PeakLabel)
	require.Equal(t, "model-a", v.BusiestModel)
	require.Equal(t, "1.2k", v.TotalTokens)
	require.Len(t, v.SessionsChart.Labels, 24)
	require.True(t, v.SessionsChart.Stacked)
	require.Equal(t, "model-a", v.SessionsChart.Datasets[0].Name)
	require.Equal(t, float64(3), v.SessionsChart.Datasets[0].Values[22])
	require.Equal(t, float64(1), v.SessionsChart.Datasets[0].Values[20])
	require.Equal(t, float64(1), v.SessionsChart.Datasets[1].Values[22])
	require.Equal(t, float64(1000), v.TokensChart.Datasets[0].Values[22])
	require.Len(t, v.Legend, 2)

	require.False(t, buildDayByModelTZ(nil, 0).HasData)
}

// TestInsightsRendersCharts asserts every card renders, guarding against
// handler↔template key mismatches.
func TestInsightsRendersCharts(t *testing.T) {
	mux := http.NewServeMux()
	sp, sh := prosav1connect.NewSessionsServiceHandler(fakeSessionsService{})
	mux.Handle(sp, sh)
	dp, dh := prosav1connect.NewDevicesServiceHandler(fakeDevicesService{})
	mux.Handle(dp, dh)
	ap, ah := prosav1connect.NewAnalyticsServiceHandler(fakeAnalyticsService{})
	mux.Handle(ap, ah)
	upstream := httptest.NewServer(mux)
	t.Cleanup(upstream.Close)

	p, err := New(Config{
		ServerURL:     upstream.URL,
		AdminToken:    "secret",
		CookieKey:     "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		OwnerEmails:   []string{"owner@example.com"},
		ListenAddr:    ":0",
		PublicBaseURL: "http://panel.test",
	})
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodGet, "/insights", nil)
	req.AddCookie(cookieFor(t, p, "owner@example.com"))
	rec := httptest.NewRecorder()
	p.mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	body := rec.Body.String()

	for _, want := range []string{
		"Spend &amp; tokens",            // trend card
		">Model share<",                 // share card
		">Punch card<",                  // punch card card
		">Session duration<",            // durations card
		">Across the day<",              // hour-of-day model/token card
		">Delegation<",                  // delegation card
		">Fan-out<",                     // fan-out histogram card
		">Top delegating sessions<",     // top delegators card
		">By parent agent<",             // per-agent breakdown card
		"current streak",                // rhythm KPI
		"busiest weekday",               // schedule KPI
		"outside 09–18h",                // schedule KPI
		`data-chart="spend-bars"`,       // spend chart container
		`data-chart="model-share"`,      // share chart container
		`data-chart="tokens-line"`,      // tokens chart container
		`data-chart="day-models"`,       // across-the-day stacked chart
		`data-chart="delegation-trend"`, // delegated-share trend chart
		"heatmap-cell level-",           // punch card cells
		"subagents-table",               // per-agent breakdown
		"max fan-out",                   // delegation KPI
		"tokens delegated",              // delegation KPI
		"est. subagent spend",           // delegation KPI
		"/sessions?session=sess-1",      // top delegator deep link
		"busiest model claude-opus-4-5", // across-the-day subtitle
		`action="/insights"`,            // filter drawer posts back here
		`class="sidebar"`,               // base chrome rendered
	} {
		require.Contains(t, body, want, "insights page should render %q", want)
	}
}
