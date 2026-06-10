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

	// No offset: stays put.
	_, grid = buildPunchcardTZ([]*prosav1.AnalyticsRow{aRow("2", "14", "7")}, 0)
	require.Equal(t, int64(7), grid[2][14])
}

func TestBuildPunchcardLevelsAndLabels(t *testing.T) {
	t.Parallel()
	view, _ := buildPunchcardTZ([]*prosav1.AnalyticsRow{
		aRow("1", "09", "8"), // max → level 4
		aRow("1", "10", "1"), // small → level 1
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
	require.Equal(t, "1,100,500", v.TotalTokens)
	require.Equal(t, "per day", v.BucketLabel)
	require.Equal(t, "05-29", v.StartLabel)
	require.Equal(t, "05-31", v.EndLabel)
	require.Contains(t, string(v.SpendChart), "stacked-chart")
	require.Contains(t, string(v.SpendChart), "USD cumulative")
	require.Contains(t, string(v.TokensChart), "area-chart")
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
	// 2026-05-25 and 2026-05-26 share an ISO week (Monday 05-25); the
	// June days fall in the next weeks.
	require.Equal(t, "05-25", v.StartLabel)
	require.Equal(t, "06-01", v.EndLabel)
	require.Contains(t, string(v.Chart), "stacked-chart")
	require.Contains(t, string(v.Chart), "%)") // normalized share titles
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

// TestInsightsRendersCharts drives the real handleInsights against the fake
// upstream and asserts every card renders — the handler↔template key
// mismatch guard, same rationale as TestHomeRendersIssuesAndCharts.
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
		"Spend &amp; tokens",    // trend card
		">Model share<",         // share card
		">Punch card<",          // punch card card
		">Session duration<",    // durations card
		">Subagents<",           // subagents card
		"current streak",        // rhythm KPI
		"busiest weekday",       // schedule KPI
		"outside 09–18h",        // schedule KPI
		`class="stacked-chart"`, // spend + share SVGs
		`class="area-chart"`,    // tokens SVG
		"heatmap-cell level-",   // punch card cells
		"subagents-table",       // per-agent breakdown
		"max fan-out",           // subagents KPI
		`action="/insights"`,    // filter drawer posts back here
		`class="sidebar"`,       // base chrome rendered
	} {
		require.Contains(t, body, want, "insights page should render %q", want)
	}
}
