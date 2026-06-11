package panel

import (
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"connectrpc.com/connect"
	"golang.org/x/sync/errgroup"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/panel/charts"
	"github.com/c3-oss/prosa/internal/panel/render"
	"github.com/c3-oss/prosa/internal/pricing"
	"github.com/c3-oss/prosa/pkg/session"
)

// insightsTrendClampDays clamps the daily-resolution reports on last=all
// so the zero-filled heatmap doesn't return ~36k rows for no visual gain.
const insightsTrendClampDays = 365

// weeklyBucketCutoverDays is where daily columns become unreadable and the
// spend/share charts switch to ISO-week buckets.
const weeklyBucketCutoverDays = 120

// handleInsights renders /insights: spend & token trend, model share, work
// rhythm (punch card, streaks, schedule, durations), and subagent fan-out.
func (p *Panel) handleInsights(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	now := nowFn().UTC()
	lastRaw, since, until, err := parseDashboardWindow(q, now)
	if err != nil {
		http.Error(w, "bad last= "+err.Error(), http.StatusBadRequest)
		return
	}
	heatmapSince, heatmapUntil := heatmapWindow(now)

	trendSince := since
	trendClamped := false
	if c := now.AddDate(0, 0, -insightsTrendClampDays); lastRaw == "all" && c.After(trendSince) {
		trendSince = c
		trendClamped = true
	}

	agents := pickMulti(q, "agent")
	projects := pickMulti(q, "project")
	devices := pickDeviceNames(q)

	sharedReq := func(report string) *prosav1.GetReportRequest {
		return dashboardReportRequest(report, since, until, agents, projects, devices)
	}
	trendReq := func(report string) *prosav1.GetReportRequest {
		return dashboardReportRequest(report, trendSince, until, agents, projects, devices)
	}

	type fan struct {
		usageByDay    *prosav1.GetReportResponse // spend & tokens trend + model share
		punchcard     *prosav1.GetReportResponse // punch card + schedule profile
		durations     *prosav1.GetReportResponse // duration histogram
		durationStats *prosav1.GetReportResponse // duration percentiles
		subagents     *prosav1.GetReportResponse // fan-out card
		heatmapTrail  *prosav1.GetReportResponse // trailing 53 weeks — streaks
		heatmapWindow *prosav1.GetReportResponse // filtered window — active days %
		projects      *prosav1.GetReportResponse // project dropdown options
	}
	var out fan
	g, gctx := errgroup.WithContext(r.Context())
	for _, spec := range []struct {
		name string
		req  *prosav1.GetReportRequest
		dst  **prosav1.GetReportResponse
	}{
		{"usage_by_day", trendReq("usage_by_day"), &out.usageByDay},
		{"punchcard", sharedReq("punchcard"), &out.punchcard},
		{"durations", sharedReq("durations"), &out.durations},
		{"duration_stats", sharedReq("duration_stats"), &out.durationStats},
		{"subagents", sharedReq("subagents"), &out.subagents},
		{"heatmap", dashboardReportRequest("heatmap", heatmapSince, heatmapUntil, agents, projects, devices), &out.heatmapTrail},
		{"heatmap_window", trendReq("heatmap"), &out.heatmapWindow},
		{"projects", sharedReq("projects"), &out.projects},
	} {
		g.Go(func() error {
			resp, err := p.clients.Analytics.GetReport(gctx, connect.NewRequest(spec.req))
			if err != nil {
				return fmt.Errorf("analytics %s: %w", spec.name, err)
			}
			*spec.dst = resp.Msg
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		slog.Error("insights fan-out failed", "err", err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	deviceNames, _, err := p.loadDeviceLookup(r.Context())
	if err != nil {
		slog.Warn("insights devices.list failed", "err", err)
	}
	projectNames := projectLabelsFromRows(out.projects.Rows)

	windowNote := ""
	if trendClamped {
		windowNote = "trailing 365d"
	}
	spend := buildSpendTrend(out.usageByDay.Rows, trendSince, until)
	share := buildModelShare(out.usageByDay.Rows)
	punch, punchGrid := buildPunchcard(out.punchcard.Rows)
	schedule := buildScheduleKPIs(punchGrid)
	streaks := buildStreaks(out.heatmapTrail.Rows, out.heatmapWindow.Rows, now)
	durations := buildDurations(out.durations.Rows, out.durationStats.Rows)
	subagents := buildSubagents(out.subagents.Rows)

	activeFilters := buildDashboardActiveFilters(r.URL.Query(), "/insights", lastRaw, agents, projects, devices)
	clearFiltersURL := ""
	if len(activeFilters) > 0 {
		clearFiltersURL = "/insights"
	}

	data := map[string]any{
		"Title":        "Insights",
		"Nav":          "insights",
		"CSRF":         p.csrfFromRequest(r),
		"PageTitle":    "Insights",
		"FilterAction": "/insights",

		// Filter state.
		"Last":             lastRaw,
		"Agents":           panelAgents,
		"AgentsSelected":   selectionSet(agents),
		"Projects":         projectNames,
		"ProjectsSelected": selectionSet(projects),
		"Devices":          deviceNames,
		"DevicesSelected":  selectionSet(devices),
		"ActiveFilters":    activeFilters,
		"ClearFiltersURL":  clearFiltersURL,

		// Rhythm KPI strip.
		"Streaks":  streaks,
		"Schedule": schedule,

		// Cards.
		"Spend":      spend,
		"Share":      share,
		"Punchcard":  punch,
		"Durations":  durations,
		"Subagents":  subagents,
		"WindowNote": windowNote,
	}
	p.render(w, "insights", data)
}

// spendTrendView powers the "Spend & tokens" card: spend columns plus a
// token-volume area chart over the same buckets.
type spendTrendView struct {
	SpendChart  charts.Spec
	TokensChart charts.Spec
	TotalSpend  string
	TotalTokens string
	BucketLabel string // "per day" | "per week"
	StartLabel  string
	EndLabel    string
	HasData     bool
}

// trendBucket is one x-slot of the spend/tokens trend.
type trendBucket struct {
	label  string
	spend  float64
	tokens int64
}

// buildSpendTrend folds usage_by_day rows into a continuous daily series
// between since and until, pricing each (day, model) via internal/pricing.
// Unpriced rows still count tokens but contribute no spend.
func buildSpendTrend(rows []*prosav1.AnalyticsRow, since, until time.Time) spendTrendView {
	dayspan := buildDaySpan(since, until)
	if len(dayspan) == 0 {
		return spendTrendView{TotalSpend: "n/a"}
	}
	spendByDay := map[string]float64{}
	tokensByDay := map[string]int64{}
	var totalTokens int64
	var totalSpend float64
	priced := false
	hasRows := false
	for _, row := range rows {
		if len(row.Values) < 10 {
			continue
		}
		hasRows = true
		day := row.Values[0]
		tokens := parsePanelInt(row.Values[4])
		tokensByDay[day] += tokens
		totalTokens += tokens
		if parsePanelInt(row.Values[3]) == 0 {
			continue // no measured usage → nothing to price
		}
		usage := session.TokenUsage{
			TotalTokens:         tokens,
			InputTokens:         parsePanelInt(row.Values[5]),
			OutputTokens:        parsePanelInt(row.Values[6]),
			CachedTokens:        parsePanelInt(row.Values[7]),
			CacheReadTokens:     parsePanelInt(row.Values[8]),
			CacheCreationTokens: parsePanelInt(row.Values[9]),
		}
		if cost, ok := pricing.CostUSD(row.Values[1], usage); ok {
			spendByDay[day] += cost
			totalSpend += cost
			priced = true
		}
	}

	buckets := make([]trendBucket, 0, len(dayspan))
	weekly := len(dayspan) > weeklyBucketCutoverDays
	bucketLabel := "per day"
	if weekly {
		bucketLabel = "per week"
	}
	for _, day := range dayspan {
		label := day[5:]
		if weekly {
			label = weekStartLabel(day)
		}
		if n := len(buckets); n > 0 && buckets[n-1].label == label {
			buckets[n-1].spend += spendByDay[day]
			buckets[n-1].tokens += tokensByDay[day]
			continue
		}
		buckets = append(buckets, trendBucket{label: label, spend: spendByDay[day], tokens: tokensByDay[day]})
	}

	labels := make([]string, len(buckets))
	spendSeries := make([]float64, len(buckets))
	tokenValues := make([]float64, len(buckets))
	for i, b := range buckets {
		labels[i] = b.label
		spendSeries[i] = b.spend
		tokenValues[i] = float64(b.tokens)
	}

	totalSpendLabel := "n/a"
	if priced {
		totalSpendLabel = fmt.Sprintf("$%.2f", totalSpend)
	}
	return spendTrendView{
		SpendChart: charts.Spec{
			Type:        "bar",
			Labels:      labels,
			Datasets:    []charts.Dataset{{Name: "est. spend", Values: spendSeries}},
			ValuePrefix: "$",
			Height:      160,
		},
		TokensChart: charts.Spec{
			Type:        "line",
			Labels:      labels,
			Datasets:    []charts.Dataset{{Name: "tokens", Values: tokenValues}},
			RegionFill:  true,
			ValueSuffix: " tokens",
			Height:      160,
		},
		TotalSpend:  totalSpendLabel,
		TotalTokens: formatPanelInt(totalTokens),
		BucketLabel: bucketLabel,
		StartLabel:  labels[0],
		EndLabel:    labels[len(labels)-1],
		HasData:     hasRows,
	}
}

// buildDaySpan lists every UTC calendar day in [since, until] as YYYY-MM-DD.
func buildDaySpan(since, until time.Time) []string {
	start := since.UTC().Truncate(24 * time.Hour)
	end := until.UTC().Truncate(24 * time.Hour)
	if end.Before(start) {
		return nil
	}
	out := make([]string, 0, int(end.Sub(start).Hours()/24)+1)
	for d := start; !d.After(end); d = d.AddDate(0, 0, 1) {
		out = append(out, d.Format("2006-01-02"))
	}
	return out
}

// weekStartLabel maps a YYYY-MM-DD day to the MM-DD of its ISO week's Monday.
func weekStartLabel(day string) string {
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		return day
	}
	monday := t.AddDate(0, 0, -((int(t.Weekday()) + 6) % 7))
	return monday.Format("01-02")
}

// shareLegendRow is one legend entry under a stacked chart: palette index,
// series name, and session count.
type shareLegendRow struct {
	ColorIdx int
	Model    string
	Sessions string
}

// modelShareView powers the "Model share" card: a normalized stacked
// chart of weekly session share per model.
type modelShareView struct {
	Chart      charts.Spec
	Legend     []shareLegendRow
	StartLabel string
	EndLabel   string
	HasData    bool
}

// modelShareTopN caps the share chart at top-4 models plus "other" (palette has five tones).
const modelShareTopN = 4

// buildModelShare folds usage_by_day rows into weekly session counts per
// model, keeps the top-N by volume, and normalizes each week to 100%.
func buildModelShare(rows []*prosav1.AnalyticsRow) modelShareView {
	type key struct{ week, model string }
	counts := map[key]int64{}
	modelTotals := map[string]int64{}
	weekSet := map[string]bool{}
	for _, row := range rows {
		if len(row.Values) < 3 {
			continue
		}
		week := weekStartLabel(row.Values[0])
		model := strings.TrimSpace(row.Values[1])
		n := parsePanelInt(row.Values[2])
		if model == "" || n <= 0 {
			continue
		}
		counts[key{week, model}] += n
		modelTotals[model] += n
		weekSet[week] = true
	}
	if len(weekSet) == 0 {
		return modelShareView{}
	}

	weeks := make([]string, 0, len(weekSet))
	for w := range weekSet {
		weeks = append(weeks, w)
	}
	sort.Strings(weeks)

	models := make([]string, 0, len(modelTotals))
	for m := range modelTotals {
		models = append(models, m)
	}
	sort.Slice(models, func(i, j int) bool {
		if modelTotals[models[i]] == modelTotals[models[j]] {
			return models[i] < models[j]
		}
		return modelTotals[models[i]] > modelTotals[models[j]]
	})
	top := models
	hasOther := false
	if len(models) > modelShareTopN {
		top = models[:modelShareTopN]
		hasOther = true
	}

	datasets := make([]charts.Dataset, 0, len(top)+1)
	legend := make([]shareLegendRow, 0, len(top)+1)
	addSeries := func(name string, totals int64, values []float64) {
		legend = append(legend, shareLegendRow{
			ColorIdx: len(datasets),
			Model:    name,
			Sessions: formatPanelInt(totals),
		})
		datasets = append(datasets, charts.Dataset{Name: name, Values: values})
	}
	for _, m := range top {
		values := make([]float64, len(weeks))
		for i, w := range weeks {
			values[i] = float64(counts[key{w, m}])
		}
		addSeries(m, modelTotals[m], values)
	}
	if hasOther {
		values := make([]float64, len(weeks))
		var otherTotal int64
		for _, m := range models[modelShareTopN:] {
			otherTotal += modelTotals[m]
			for i, w := range weeks {
				values[i] += float64(counts[key{w, m}])
			}
		}
		addSeries("other", otherTotal, values)
	}

	// Frappe has no percentage-stacked mode, so normalize each week's
	// column to 100% here; empty weeks stay at zero.
	for w := range weeks {
		var colTotal float64
		for _, d := range datasets {
			colTotal += d.Values[w]
		}
		if colTotal <= 0 {
			continue
		}
		for di := range datasets {
			datasets[di].Values[w] = datasets[di].Values[w] / colTotal * 100
		}
	}

	return modelShareView{
		Chart: charts.Spec{
			Type:        "bar",
			Labels:      weeks,
			Datasets:    datasets,
			Stacked:     true,
			ValueSuffix: "%",
			Height:      180,
		},
		Legend:     legend,
		StartLabel: weeks[0],
		EndLabel:   weeks[len(weeks)-1],
		HasData:    true,
	}
}

// punchcardCell is one (weekday, hour) slot of the punch card grid.
type punchcardCell struct {
	Count int64
	Level int
	Label string // hover/a11y: "Mon 14h: 3 sessions"
}

// punchcardRow is one weekday row of the punch card.
type punchcardRow struct {
	Label string
	Cells []punchcardCell
}

// punchcardView powers the punch card card: 7 weekday rows × 24 local hours.
type punchcardView struct {
	Rows  []punchcardRow
	Total int64
}

// punchcardGrid carries the rotated local-time counts shared with the schedule KPIs.
type punchcardGrid [7][24]int64

// buildPunchcard rotates the UTC punchcard report into the panel's local zone.
func buildPunchcard(rows []*prosav1.AnalyticsRow) (punchcardView, punchcardGrid) {
	_, offsetSec := nowFn().In(time.Local).Zone()
	return buildPunchcardTZ(rows, offsetSec/3600)
}

// buildPunchcardTZ is buildPunchcard with the hour offset injected for
// tests. Rotating past midnight carries into the adjacent weekday.
func buildPunchcardTZ(rows []*prosav1.AnalyticsRow, offsetHours int) (punchcardView, punchcardGrid) {
	var grid punchcardGrid
	var total int64
	for _, row := range rows {
		if len(row.Values) < 3 {
			continue
		}
		dow := int(parsePanelInt(row.Values[0]))
		hour := int(parsePanelInt(row.Values[1]))
		n := parsePanelInt(row.Values[2])
		if dow < 0 || dow > 6 || hour < 0 || hour > 23 || n <= 0 {
			continue
		}
		shifted := hour + offsetHours
		localHour := ((shifted % 24) + 24) % 24
		dayCarry := 0
		switch {
		case shifted >= 24:
			dayCarry = 1
		case shifted < 0:
			dayCarry = -1
		}
		localDow := ((dow+dayCarry)%7 + 7) % 7
		grid[localDow][localHour] += n
		total += n
	}

	var max int64
	for d := range grid {
		for h := range grid[d] {
			if grid[d][h] > max {
				max = grid[d][h]
			}
		}
	}

	weekdays := []string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}
	view := punchcardView{Total: total, Rows: make([]punchcardRow, 7)}
	for d := range grid {
		cells := make([]punchcardCell, 24)
		for h := range grid[d] {
			n := grid[d][h]
			level := 0
			if max > 0 && n > 0 {
				level = min(int((n*4+max-1)/max), 4)
			}
			cells[h] = punchcardCell{
				Count: n,
				Level: level,
				Label: fmt.Sprintf("%s %02dh: %s", weekdays[d], h, pluralize(n, "session", "sessions")),
			}
		}
		view.Rows[d] = punchcardRow{Label: weekdays[d], Cells: cells}
	}
	return view, grid
}

// scheduleView powers the schedule-profile KPIs, derived from the punch card grid.
type scheduleView struct {
	WeekendPct  string
	OffHoursPct string // outside 09–18h local
	BusiestDay  string
	HasData     bool
}

// buildScheduleKPIs reduces the punch card grid to weekend share, off-hours
// share (before 09h or 18h+), and the busiest weekday.
func buildScheduleKPIs(grid punchcardGrid) scheduleView {
	var total, weekend, offHours int64
	var busiest int64 = -1
	busiestDay := time.Sunday
	for d := range grid {
		var dayTotal int64
		for h := range grid[d] {
			n := grid[d][h]
			dayTotal += n
			total += n
			if d == 0 || d == 6 {
				weekend += n
			}
			if h < 9 || h >= 18 {
				offHours += n
			}
		}
		if dayTotal > busiest {
			busiest = dayTotal
			busiestDay = time.Weekday(d)
		}
	}
	if total == 0 {
		return scheduleView{WeekendPct: "—", OffHoursPct: "—", BusiestDay: "—"}
	}
	pct := func(n int64) string {
		return fmt.Sprintf("%.0f%%", float64(n)/float64(total)*100)
	}
	return scheduleView{
		WeekendPct:  pct(weekend),
		OffHoursPct: pct(offHours),
		BusiestDay:  busiestDay.String(),
		HasData:     true,
	}
}

// streaksView powers the consistency KPIs: streaks from the trailing 53-week
// heatmap, active-day share from the filtered window.
type streaksView struct {
	Current    string // "4 days"
	Longest    string // "11 days"
	ActivePct  string // "62%"
	ActiveDays string // "45 / 72 days"
}

// buildStreaks computes the current streak (active days ending today, or
// yesterday when today is quiet), the longest streak, and the active-day
// share over the filtered window. Days are UTC dates.
func buildStreaks(trailingRows, windowRows []*prosav1.AnalyticsRow, now time.Time) streaksView {
	trailing := foldDayTotals(trailingRows)

	today := now.UTC().Truncate(24 * time.Hour)
	cursor := today
	if trailing[cursor.Format("2006-01-02")] == 0 {
		cursor = cursor.AddDate(0, 0, -1)
	}
	var current int64
	for trailing[cursor.Format("2006-01-02")] > 0 {
		current++
		cursor = cursor.AddDate(0, 0, -1)
	}

	dates := make([]string, 0, len(trailing))
	for d := range trailing {
		dates = append(dates, d)
	}
	sort.Strings(dates)
	var longest, run int64
	prev := ""
	for _, d := range dates {
		if trailing[d] == 0 {
			run = 0
			prev = d
			continue
		}
		if prev != "" && nextDay(prev) != d {
			run = 0
		}
		run++
		prev = d
		if run > longest {
			longest = run
		}
	}

	window := foldDayTotals(windowRows)
	var active int64
	for _, n := range window {
		if n > 0 {
			active++
		}
	}
	total := int64(len(window))
	activePct := "—"
	if total > 0 {
		activePct = fmt.Sprintf("%.0f%%", float64(active)/float64(total)*100)
	}
	return streaksView{
		Current:    pluralize(current, "day", "days"),
		Longest:    pluralize(longest, "day", "days"),
		ActivePct:  activePct,
		ActiveDays: fmt.Sprintf("%d / %s", active, pluralize(total, "day", "days")),
	}
}

// foldDayTotals sums heatmap rows per day. The server zero-fills missing days,
// so the key set spans the whole queried window.
func foldDayTotals(rows []*prosav1.AnalyticsRow) map[string]int64 {
	out := map[string]int64{}
	for _, row := range rows {
		if len(row.Values) == 0 || row.Values[0] == "" {
			continue
		}
		if _, ok := out[row.Values[0]]; !ok {
			out[row.Values[0]] = 0
		}
		if len(row.Values) < 3 {
			continue
		}
		out[row.Values[0]] += parsePanelInt(row.Values[2])
	}
	return out
}

// nextDay advances a YYYY-MM-DD string by one calendar day.
func nextDay(day string) string {
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		return ""
	}
	return t.AddDate(0, 0, 1).Format("2006-01-02")
}

// durationsView powers the session-duration card: a bucket histogram plus percentile stats.
type durationsView struct {
	Bars    []barRow
	Median  string
	P90     string
	Avg     string
	Longest string
	HasData bool
}

// durationBuckets is the canonical bucket order; the server emits unordered pairs keyed by these labels.
var durationBuckets = []string{"<5m", "5-15m", "15-30m", "30-60m", "1-2h", ">2h"}

// buildDurations shapes the durations + duration_stats reports into the
// histogram card, keeping the canonical bucket order (not barsFromPairs, which sorts by count).
func buildDurations(bucketRows, statsRows []*prosav1.AnalyticsRow) durationsView {
	counts := map[string]int64{}
	var max, total int64
	for _, row := range bucketRows {
		if len(row.Values) < 2 {
			continue
		}
		n := parsePanelInt(row.Values[1])
		counts[row.Values[0]] = n
		total += n
		if n > max {
			max = n
		}
	}
	bars := make([]barRow, 0, len(durationBuckets))
	for _, bucket := range durationBuckets {
		n := counts[bucket]
		percent := 0
		if max > 0 && n > 0 {
			percent = int((n*100 + max - 1) / max)
			if percent < 3 {
				percent = 3
			}
		}
		bars = append(bars, barRow{Label: bucket, Count: formatPanelInt(n), Percent: percent})
	}

	stat := func(idx int) string {
		if len(statsRows) == 0 || len(statsRows[0].Values) <= idx {
			return "—"
		}
		s := parsePanelInt(statsRows[0].Values[idx])
		return render.HumanDuration(time.Duration(s) * time.Second)
	}
	return durationsView{
		Bars:    bars,
		Median:  stat(0),
		P90:     stat(1),
		Avg:     stat(2),
		Longest: stat(3),
		HasData: total > 0,
	}
}

// subagentPanelRow is one per-agent line of the subagents card.
type subagentPanelRow struct {
	Agent    template.HTML
	Parents  string
	Children string
	MaxFan   string
}

// subagentsView powers the subagent fan-out card: totals plus the per-parent-agent breakdown.
type subagentsView struct {
	Parents  string
	Children string
	MaxFan   string
	Rows     []subagentPanelRow
	HasData  bool
}

// buildSubagents shapes the subagents report (grouped by parent agent) into the card.
func buildSubagents(rows []*prosav1.AnalyticsRow) subagentsView {
	view := subagentsView{}
	var parents, children, maxFan int64
	for _, row := range rows {
		if len(row.Values) < 4 {
			continue
		}
		p := parsePanelInt(row.Values[1])
		c := parsePanelInt(row.Values[2])
		f := parsePanelInt(row.Values[3])
		parents += p
		children += c
		maxFan = max(maxFan, f)
		view.Rows = append(view.Rows, subagentPanelRow{
			Agent:    agentBadge(row.Values[0]),
			Parents:  formatPanelInt(p),
			Children: formatPanelInt(c),
			MaxFan:   formatPanelInt(f),
		})
	}
	view.Parents = formatPanelInt(parents)
	view.Children = formatPanelInt(children)
	view.MaxFan = formatPanelInt(maxFan)
	view.HasData = len(view.Rows) > 0
	return view
}
