package panel

import (
	"fmt"
	"html/template"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	"golang.org/x/sync/errgroup"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/panel/charts"
)

// handleHome renders the dashboard: KPI strip + heatmap card + tools /
// models / errors / usage cards. Filters live in a collapsible <details>
// block; they apply to every card except the heatmap (which is fixed at
// the trailing 53 weeks). All reports fan out in parallel — the panel
// is single-user, the Postgres queries are indexed, and the per-card
// shape stays small enough that five independent RPCs beat one
// aggregated dashboard RPC (cf. INTENT § "V2 platform trap").
func (p *Panel) handleHome(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	now := nowFn().UTC()
	lastRaw, defaultLast := p.resolvePageWindow(r, windowPageHome)
	since, until, err := parseDashboardWindow(lastRaw, now)
	if err != nil {
		http.Error(w, "bad last= "+err.Error(), http.StatusBadRequest)
		return
	}
	heatmapSince, heatmapUntil := heatmapWindow(now)

	agents := pickMulti(q, "agent")
	projects := pickMulti(q, "project")
	devices := pickDeviceNames(q)
	profilesSel := pickMulti(q, "profile")

	// Heatmap uses its own request so the fixed-window override doesn't
	// bleed into the windowed reports.
	sharedReq := func(report string) *prosav1.GetReportRequest {
		return dashboardReportRequest(report, since, until, agents, projects, devices, profilesSel)
	}
	heatmapReq := dashboardReportRequest("heatmap", heatmapSince, heatmapUntil, agents, projects, devices, profilesSel)

	// Daily activity trend over the filtered window; clamp last=all to
	// 365d so the server doesn't zero-fill ~36k days.
	trendSince := since
	trendNote := ""
	if c := now.AddDate(0, 0, -insightsTrendClampDays); lastRaw == "all" && c.After(trendSince) {
		trendSince = c
		trendNote = "trailing 365d"
	}
	trendReq := dashboardReportRequest("heatmap", trendSince, until, agents, projects, devices, profilesSel)

	// limit=1 yields the unfiltered total cheaply for the sessions KPI.
	sessionsListReq := func(s, u time.Time) *prosav1.ListRequest {
		req := &prosav1.ListRequest{
			Since:       timestamppb.New(s),
			Until:       timestamppb.New(u),
			Limit:       1,
			DeviceNames: devices,
			Profiles:    profilesSel,
		}
		if len(agents) == 1 {
			req.Agent = agents[0]
		}
		if len(projects) == 1 {
			req.ProjectMatch = projects[0]
		}
		return req
	}

	type fan struct {
		sessions      *prosav1.ListResponse
		tools         *prosav1.GetReportResponse
		models        *prosav1.GetReportResponse
		errors        *prosav1.GetReportResponse
		usage         *prosav1.GetReportResponse
		heatmap       *prosav1.GetReportResponse
		projects      *prosav1.GetReportResponse // Projects KPI + chart + dropdown
		profiles      *prosav1.GetReportResponse // profile dropdown options
		usageByModel  *prosav1.GetReportResponse // tokens & cost per model card
		errorsByModel *prosav1.GetReportResponse // errors per model (Issues)
		hours         *prosav1.GetReportResponse // activity by hour card
		trend         *prosav1.GetReportResponse // daily activity trend card

		// Previous window of equal length, for the KPI deltas.
		prevSessions *prosav1.ListResponse
		prevModels   *prosav1.GetReportResponse
		prevUsage    *prosav1.GetReportResponse
		prevProjects *prosav1.GetReportResponse
		prevErrors   *prosav1.GetReportResponse
	}
	var out fan
	g, gctx := errgroup.WithContext(r.Context())
	g.Go(func() error {
		resp, err := p.clients.Sessions.List(gctx, connect.NewRequest(sessionsListReq(since, until)))
		if err != nil {
			return fmt.Errorf("sessions.list: %w", err)
		}
		out.sessions = resp.Msg
		return nil
	})
	type reportSpec struct {
		name string
		req  *prosav1.GetReportRequest
		dst  **prosav1.GetReportResponse
	}
	specs := []reportSpec{
		{"tools", sharedReq("tools"), &out.tools},
		{"models", sharedReq("models"), &out.models},
		{"errors", sharedReq("errors"), &out.errors},
		{"usage", sharedReq("usage"), &out.usage},
		{"projects", sharedReq("projects"), &out.projects},
		{"profiles", sharedReq("profiles"), &out.profiles},
		{"heatmap", heatmapReq, &out.heatmap},
		{"usage_by_model", sharedReq("usage_by_model"), &out.usageByModel},
		{"errors_by_model", sharedReq("errors_by_model"), &out.errorsByModel},
		{"hours", sharedReq("hours"), &out.hours},
		{"trend", trendReq, &out.trend},
	}
	compare := lastRaw != "all"
	if compare {
		prevSince := since.Add(-until.Sub(since))
		prevReq := func(report string) *prosav1.GetReportRequest {
			return dashboardReportRequest(report, prevSince, since, agents, projects, devices, profilesSel)
		}
		specs = append(
			specs,
			reportSpec{"models_prev", prevReq("models"), &out.prevModels},
			reportSpec{"usage_prev", prevReq("usage"), &out.prevUsage},
			reportSpec{"projects_prev", prevReq("projects"), &out.prevProjects},
			reportSpec{"errors_by_model_prev", prevReq("errors_by_model"), &out.prevErrors},
		)
		g.Go(func() error {
			resp, err := p.clients.Sessions.List(gctx, connect.NewRequest(sessionsListReq(prevSince, since)))
			if err != nil {
				return fmt.Errorf("sessions.list prev: %w", err)
			}
			out.prevSessions = resp.Msg
			return nil
		})
	}
	for _, spec := range specs {
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
		slog.Error("home dashboard fan-out failed", "err", err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	deviceNames, _, err := p.loadDeviceLookup(r.Context())
	if err != nil {
		slog.Warn("home devices.list failed", "err", err)
	}
	projectNames := projectLabelsFromRows(out.projects.Rows)
	profileNames := profileLabelsFromRows(out.profiles.Rows)

	heatmap := buildHeatmap(out.heatmap.Rows)
	usageRows, usageTokens, usageCost, usagePriced := buildUsage(out.usage.Rows)
	usageCostLabel := costLabel(usageCost, usagePriced)
	projectBars := buildProjectBars(out.projects.Rows, 10)
	modelUsage := buildModelUsage(out.usageByModel.Rows)
	hourChart := buildHourChart(out.hours.Rows)
	issues := buildIssues(out.errorsByModel.Rows, out.errors.Rows, out.sessions.TotalCount)
	trend := buildActivityTrend(out.trend.Rows)

	// KPI deltas vs the previous window of equal length.
	var dSessions, dProjects, dModels, dTokens, dSpend, dErrorRate *kpiDelta
	if compare {
		dSessions = buildKPIDelta(float64(out.sessions.TotalCount), float64(out.prevSessions.TotalCount), deltaUpGood)
		dProjects = buildKPIDelta(float64(len(projectNames)), float64(len(projectLabelsFromRows(out.prevProjects.Rows))), deltaUpGood)
		dModels = buildKPIDelta(float64(len(out.models.Rows)), float64(len(out.prevModels.Rows)), deltaUpGood)
		_, prevTokens, prevCost, prevPriced := buildUsage(out.prevUsage.Rows)
		dTokens = buildKPIDelta(float64(usageTokens), float64(prevTokens), deltaUpGood)
		if usagePriced || prevPriced {
			dSpend = buildKPIDelta(usageCost, prevCost, deltaNeutral)
		}
		dErrorRate = buildKPIDelta(
			errorRatePct(issues.Flagged, out.sessions.TotalCount),
			errorRatePct(flaggedTotal(out.prevErrors.Rows), out.prevSessions.TotalCount),
			deltaUpBad,
		)
	}
	kpis := []kpiView{
		{Value: formatPanelInt(out.sessions.TotalCount), Label: "sessions", Delta: dSessions},
		{Value: formatPanelInt(int64(len(projectNames))), Label: "projects", Delta: dProjects},
		{Value: formatPanelInt(int64(len(out.models.Rows))), Label: "models", Delta: dModels},
		{Value: formatPanelInt(usageTokens), Label: "tokens", Delta: dTokens},
		{Value: usageCostLabel, Label: "est. spend", Delta: dSpend},
		{Value: issues.Rate, Label: "error rate", Delta: dErrorRate},
	}

	activeFilters := buildDashboardActiveFilters(r.URL.Query(), "/", lastRaw, defaultLast, agents, projects, devices, profilesSel)
	clearFiltersURL := ""
	if len(activeFilters) > 0 {
		clearFiltersURL = clearFiltersTarget("/", lastRaw, defaultLast)
	}

	data := map[string]any{
		"Title":        "Home",
		"Nav":          "home",
		"CSRF":         p.csrfFromRequest(r),
		"PageTitle":    "Home",
		"FilterAction": "/",

		"Last":             lastRaw,
		"DefaultWindow":    defaultLast,
		"Agents":           panelAgents,
		"AgentsSelected":   selectionSet(agents),
		"Projects":         projectNames,
		"ProjectsSelected": selectionSet(projects),
		"Devices":          deviceNames,
		"DevicesSelected":  selectionSet(devices),
		"Profiles":         profileNames,
		"ProfilesSelected": selectionSet(profilesSel),
		"ActiveFilters":    activeFilters,
		"ClearFiltersURL":  clearFiltersURL,

		// KPI strip (value + optional vs-previous-window delta badge).
		"KPIs": kpis,

		// Activity trend card (chart: sessions per day/week, by agent).
		"Trend":     trend,
		"TrendNote": trendNote,

		"HeatmapCells":    heatmap.Cells,
		"HeatmapTotal":    heatmap.Total,
		"HeatmapMax":      heatmap.Max,
		"HeatmapWeekdays": heatmap.Weekdays,
		"HeatmapMonths":   heatmap.Months,
		"HeatmapColumns":  heatmap.Columns,

		"ToolHeaders": out.tools.Headers,
		"ToolBars":    buildBarRows(out.tools.Rows, 10),

		"ModelHeaders": out.models.Headers,
		"ModelBars":    buildBarRows(out.models.Rows, 10),

		"ProjectBars": projectBars,
		"HourChart":   hourChart.Chart,
		"HourPeak":    hourChart.PeakLabel,

		"IssuesFlagged":  issues.Flagged,
		"IssuesRate":     issues.Rate,
		"IssuesTopModel": issues.TopModel,
		"IssuesBars":     issues.PerModelBars,
		"IssuesRecent":   issues.Recent,

		"ModelTokenBars":   modelUsage.TokenBars,
		"CostDonut":        modelUsage.CostDonut,
		"ModelCostLegend":  modelUsage.CostLegend,
		"ModelTotalTokens": modelUsage.TotalTokens,
		"ModelTotalCost":   modelUsage.TotalCost,

		"UsageRows":        usageRows,
		"UsageTotalTokens": formatPanelInt(usageTokens),
		"UsageTotalCost":   usageCostLabel,
	}
	p.render(w, r, "home", data)
}

// barRow is a single bar in a horizontal bar leaderboard. Used by the
// Home tools/models cards. Pre-formatted so the template is dumb.
type barRow struct {
	Label   string
	Count   string
	Percent int
}

// buildBarRows turns analytics rows whose first column is the label and
// second column is a count into bar rows (sorted desc, capped at limit),
// formatted with thousands separators. Shared machinery lives in
// barsFromPairs.
func buildBarRows(rows []*prosav1.AnalyticsRow, limit int) []barRow {
	labels := make([]string, 0, len(rows))
	counts := make([]int64, 0, len(rows))
	for _, row := range rows {
		if len(row.Values) < 2 {
			continue
		}
		labels = append(labels, row.Values[0])
		counts = append(counts, parsePanelInt(row.Values[1]))
	}
	return barsFromPairs(labels, counts, limit, formatPanelInt)
}

// barsFromPairs builds a sorted, capped bar leaderboard from parallel
// label/count slices, formatting each count with the given formatter. It is
// the shared core behind buildBarRows, buildProjectBars, and the per-model
// token bars (whose counts live in a column other than 1, or want compact
// formatting). Empty labels and non-positive counts are dropped; each bar
// gets a minimum 3% width so a non-zero value is always visible.
func barsFromPairs(labels []string, counts []int64, limit int, format func(int64) string) []barRow {
	type parsed struct {
		label string
		count int64
	}
	xs := make([]parsed, 0, len(labels))
	var max int64
	for i, label := range labels {
		label = strings.TrimSpace(label)
		if label == "" || counts[i] <= 0 {
			continue
		}
		xs = append(xs, parsed{label: label, count: counts[i]})
		if counts[i] > max {
			max = counts[i]
		}
	}
	sort.SliceStable(xs, func(i, j int) bool {
		if xs[i].count == xs[j].count {
			return xs[i].label < xs[j].label
		}
		return xs[i].count > xs[j].count
	})
	if limit > 0 && len(xs) > limit {
		xs = xs[:limit]
	}
	out := make([]barRow, 0, len(xs))
	for _, x := range xs {
		percent := 0
		if max > 0 {
			percent = int((x.count*100 + max - 1) / max)
			if percent < 3 {
				percent = 3
			}
		}
		out = append(out, barRow{Label: x.label, Count: format(x.count), Percent: percent})
	}
	return out
}

// clampRows returns at most limit rows. Convenience for dashboard
// cards that surface "the last N" without bothering to compute a
// dedicated query.
func clampRows(rows []*prosav1.AnalyticsRow, limit int) []*prosav1.AnalyticsRow {
	if limit > 0 && len(rows) > limit {
		return rows[:limit]
	}
	return rows
}

// projectLabelsFromRows extracts unique project labels (first column
// of each analytics-projects row) for use as the project dropdown
// option set. Sorted alphabetically; empties dropped.
func projectLabelsFromRows(rows []*prosav1.AnalyticsRow) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		if len(row.Values) == 0 {
			continue
		}
		v := strings.TrimSpace(row.Values[0])
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}

// profileLabelsFromRows extracts unique profile labels (third column of
// each analytics-profiles row) for use as the profile dropdown option
// set. Sorted alphabetically; empties dropped.
func profileLabelsFromRows(rows []*prosav1.AnalyticsRow) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		if len(row.Values) < 3 {
			continue
		}
		v := strings.TrimSpace(row.Values[2])
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}

// heatmapWindow returns the fixed trailing-year window used by the
// heatmap report: 53 weeks aligned to Sunday in UTC (52 prior weeks
// plus the current one). Mirror of internal/cli/window.go HeatmapWindow.
// Canonical spec: docs/panel/screens.md (heatmap).
func heatmapWindow(now time.Time) (since, until time.Time) {
	u := now.UTC()
	today := time.Date(u.Year(), u.Month(), u.Day(), 0, 0, 0, 0, time.UTC)
	startOfThisWeek := today.AddDate(0, 0, -int(today.Weekday()))
	return startOfThisWeek.AddDate(0, 0, -52*7), u
}

type heatmapCell struct {
	Date   string
	Count  int64
	Level  int
	Blank  bool
	Agents []heatmapAgentSlice
}

// heatmapAgentSlice is one row of the per-day breakdown surfaced in
// the hover tooltip; the slice is sorted by Count desc.
type heatmapAgentSlice struct {
	Name  string
	Count int64
}

// heatmapView is the rendered heatmap: the flat cell stream (laid out
// column-by-column, 7 rows each), plus the axis labels the template
// needs to draw weekday rows and month headers, plus the summary.
type heatmapView struct {
	Cells    []heatmapCell
	Weekdays []string
	Months   []heatmapMonth
	Columns  int
	Total    int64
	Max      int64
}

// heatmapMonth is one band of the month axis. Span is the number of
// weekly columns this month covers in the current window; Label is the
// short month name, or empty when the band is too narrow to fit it
// without crashing into the next band.
type heatmapMonth struct {
	Label string
	Span  int
}

// buildHeatmap consumes per-(day, agent) rows and folds them into one
// cell per calendar day. Server emits (date, agent, sessions); days
// with zero sessions arrive as (date, "", 0). The Cells slice is laid
// out column-major (7 rows per column) for the GitHub-style grid.
func buildHeatmap(rows []*prosav1.AnalyticsRow) heatmapView {
	type dayBucket struct {
		date   string
		total  int64
		agents []heatmapAgentSlice
	}
	order := []string{}
	buckets := map[string]*dayBucket{}
	for _, row := range rows {
		if len(row.Values) == 0 {
			continue
		}
		date := row.Values[0]
		if date == "" {
			continue
		}
		b, ok := buckets[date]
		if !ok {
			b = &dayBucket{date: date}
			buckets[date] = b
			order = append(order, date)
		}
		if len(row.Values) < 3 {
			continue
		}
		agent := row.Values[1]
		n, _ := strconv.ParseInt(row.Values[2], 10, 64)
		if agent == "" || n == 0 {
			continue
		}
		b.total += n
		b.agents = append(b.agents, heatmapAgentSlice{Name: agent, Count: n})
	}

	var max, total int64
	for _, b := range buckets {
		if b.total > max {
			max = b.total
		}
		total += b.total
		sort.Slice(b.agents, func(i, j int) bool {
			if b.agents[i].Count == b.agents[j].Count {
				return b.agents[i].Name < b.agents[j].Name
			}
			return b.agents[i].Count > b.agents[j].Count
		})
	}

	view := heatmapView{
		Weekdays: []string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"},
		Total:    total,
		Max:      max,
	}

	var leadingBlanks int
	if len(order) > 0 {
		if t, err := time.Parse("2006-01-02", order[0]); err == nil {
			leadingBlanks = int(t.Weekday())
			for i := 0; i < leadingBlanks; i++ {
				view.Cells = append(view.Cells, heatmapCell{Blank: true})
			}
		}
	}
	for _, date := range order {
		b := buckets[date]
		level := 0
		if max > 0 && b.total > 0 {
			level = int((b.total*4 + max - 1) / max)
			if level > 4 {
				level = 4
			}
		}
		view.Cells = append(view.Cells, heatmapCell{
			Date:   date,
			Count:  b.total,
			Level:  level,
			Agents: b.agents,
		})
	}

	view.Columns = (len(view.Cells) + 6) / 7
	view.Months = monthBands(view.Cells, view.Columns)
	return view
}

// monthBands collapses adjacent columns of the same calendar month into
// one band so the template can render each month label with
// `grid-column: span N` instead of overflowing into the next month.
// Bands narrower than two columns drop their label (no room for "Apr"
// in 12 px) but still occupy their grid slot.
func monthBands(cells []heatmapCell, columns int) []heatmapMonth {
	bands := make([]heatmapMonth, 0, columns)
	var lastMonth time.Month
	for col := 0; col < columns; col++ {
		var t time.Time
		var found bool
		for row := 0; row < 7; row++ {
			idx := col*7 + row
			if idx >= len(cells) {
				break
			}
			c := cells[idx]
			if c.Blank || c.Date == "" {
				continue
			}
			parsed, err := time.Parse("2006-01-02", c.Date)
			if err != nil {
				continue
			}
			t = parsed
			found = true
			break
		}
		if !found {
			if len(bands) == 0 {
				bands = append(bands, heatmapMonth{Span: 1})
				continue
			}
			bands[len(bands)-1].Span++
			continue
		}
		if t.Month() != lastMonth {
			bands = append(bands, heatmapMonth{Label: t.Month().String()[:3], Span: 1})
			lastMonth = t.Month()
			continue
		}
		bands[len(bands)-1].Span++
	}
	for i := range bands {
		if bands[i].Span < 2 {
			bands[i].Label = ""
		}
	}
	return bands
}

type usagePanelRow struct {
	Agent    string
	Sessions string
	Measured string
	Total    string
	Input    string
	Output   string
	Cached   string
	Cost     string
	Percent  int
}

// costLabel renders estimated spend as "$X.XX", or "n/a" when unpriced.
func costLabel(cost float64, priced bool) string {
	if !priced {
		return "n/a"
	}
	return fmt.Sprintf("$%.2f", cost)
}

func buildUsage(rows []*prosav1.AnalyticsRow) ([]usagePanelRow, int64, float64, bool) {
	type parsedRow struct {
		values usagePanelRow
		total  int64
		cost   float64
		priced bool
	}
	// Agents with zero total tokens are hidden: Cursor (and any other
	// source that doesn't record per-message token usage on disk) would
	// otherwise show as a perpetual "n/a" row. The user only wants the
	// panel to surface agents where at least one session was measured.
	parsed := make([]parsedRow, 0, len(rows))
	var maxTotal int64
	for _, row := range rows {
		if len(row.Values) < 8 {
			continue
		}
		total := parsePanelInt(row.Values[3])
		if total == 0 {
			continue
		}
		if total > maxTotal {
			maxTotal = total
		}
		costStr := strings.TrimSpace(row.Values[7])
		costLabel := "n/a"
		var costFloat float64
		priced := false
		if costStr != "" {
			if f, err := strconv.ParseFloat(costStr, 64); err == nil {
				costFloat = f
				priced = true
				costLabel = fmt.Sprintf("$%.2f", f)
			} else {
				costLabel = "$" + costStr
			}
		}
		parsed = append(parsed, parsedRow{
			total:  total,
			cost:   costFloat,
			priced: priced,
			values: usagePanelRow{
				Agent:    row.Values[0],
				Sessions: formatPanelInt(parsePanelInt(row.Values[1])),
				Measured: formatPanelInt(parsePanelInt(row.Values[2])),
				Total:    formatPanelInt(total),
				Input:    formatPanelInt(parsePanelInt(row.Values[4])),
				Output:   formatPanelInt(parsePanelInt(row.Values[5])),
				Cached:   formatPanelInt(parsePanelInt(row.Values[6])),
				Cost:     costLabel,
			},
		})
	}

	out := make([]usagePanelRow, 0, len(parsed))
	var totalTokens int64
	var totalCost float64
	priced := false
	for _, row := range parsed {
		percent := 0
		if maxTotal > 0 && row.total > 0 {
			percent = int((row.total*100 + maxTotal - 1) / maxTotal)
			if percent < 3 {
				percent = 3
			}
		}
		row.values.Percent = percent
		totalTokens += row.total
		if row.priced {
			totalCost += row.cost
			priced = true
		}
		out = append(out, row.values)
	}
	return out, totalTokens, totalCost, priced
}

// buildProjectBars folds the projects report's per-(project, agent) rows into
// one bar per project (sessions summed across agents), labeled with the
// friendly project display (owner/repo or ~/path). Chart: most worked-on
// projects.
func buildProjectBars(rows []*prosav1.AnalyticsRow, limit int) []barRow {
	totals := map[string]int64{}
	order := make([]string, 0, len(rows))
	for _, row := range rows {
		if len(row.Values) < 3 {
			continue
		}
		project := strings.TrimSpace(row.Values[0])
		if project == "" {
			continue
		}
		if _, seen := totals[project]; !seen {
			order = append(order, project)
		}
		totals[project] += parsePanelInt(row.Values[2])
	}
	labels := make([]string, 0, len(order))
	counts := make([]int64, 0, len(order))
	for _, project := range order {
		labels = append(labels, projectDisplayFromLabel(project).Label)
		counts = append(counts, totals[project])
	}
	return barsFromPairs(labels, counts, limit, formatPanelInt)
}

// costLegendRow is one entry beside the cost donut: palette index, model
// name, and estimated spend.
type costLegendRow struct {
	ColorIdx int
	Model    string
	Cost     string
}

// modelUsageView bundles the "tokens & cost per model" card: a token
// leaderboard, a cost-share donut with a matching legend, and the totals for
// the card header.
type modelUsageView struct {
	TokenBars   []barRow
	CostDonut   charts.Spec
	CostLegend  []costLegendRow
	TotalTokens string
	TotalCost   string
}

// buildModelUsage shapes the usage_by_model rows
// (MODEL, SESSIONS, TOTAL, INPUT, OUTPUT, EST_COST_USD) into the card.
func buildModelUsage(rows []*prosav1.AnalyticsRow) modelUsageView {
	labels := make([]string, 0, len(rows))
	tokenCounts := make([]int64, 0, len(rows))
	var donutLabels []string
	var donutValues []float64
	var totalTokens int64
	var totalCost float64
	priced := false
	for _, row := range rows {
		if len(row.Values) < 6 {
			continue
		}
		model := strings.TrimSpace(row.Values[0])
		if model == "" {
			continue
		}
		total := parsePanelInt(row.Values[2])
		labels = append(labels, model)
		tokenCounts = append(tokenCounts, total)
		totalTokens += total
		if costStr := strings.TrimSpace(row.Values[5]); costStr != "" {
			if c, err := strconv.ParseFloat(costStr, 64); err == nil && c > 0 {
				donutLabels = append(donutLabels, model)
				donutValues = append(donutValues, c)
				totalCost += c
				priced = true
			}
		}
	}
	totalCostLabel := "n/a"
	if priced {
		totalCostLabel = fmt.Sprintf("$%.2f", totalCost)
	}
	legend := make([]costLegendRow, 0, len(donutLabels))
	for i, model := range donutLabels {
		legend = append(legend, costLegendRow{
			ColorIdx: i,
			Model:    model,
			Cost:     fmt.Sprintf("$%.2f", donutValues[i]),
		})
	}
	return modelUsageView{
		TokenBars: barsFromPairs(labels, tokenCounts, 8, formatTokensCompact),
		CostDonut: charts.Spec{
			Type:        "donut",
			Labels:      donutLabels,
			Datasets:    []charts.Dataset{{Values: donutValues}},
			ValuePrefix: "$",
			Height:      200,
		},
		CostLegend:  legend,
		TotalTokens: formatPanelInt(totalTokens),
		TotalCost:   totalCostLabel,
	}
}

// hourChartView is the "activity by hour" card: the area chart spec plus a
// peak-hour label for the card subtitle.
type hourChartView struct {
	Chart     charts.Spec
	PeakLabel string
}

// buildHourChart folds the hours report (UTC HOUR, SESSIONS) into a 24-slot
// array, rotates it into the panel's local zone for display, and renders an
// area chart. The rotation is whole-hour and DST-naive (it uses the current
// local offset, honoring the standard TZ env) — fine for "what hours do I
// work" at MVP. The report itself stays canonically UTC.
func buildHourChart(rows []*prosav1.AnalyticsRow) hourChartView {
	_, offsetSec := nowFn().In(time.Local).Zone()
	return buildHourChartTZ(rows, offsetSec/3600)
}

// buildHourChartTZ is buildHourChart with the local hour offset injected, so
// the rotation is unit-testable without mutating the process timezone.
func buildHourChartTZ(rows []*prosav1.AnalyticsRow, offsetHours int) hourChartView {
	var utc [24]int64
	for _, row := range rows {
		if len(row.Values) < 2 {
			continue
		}
		h := int(parsePanelInt(row.Values[0]))
		if h < 0 || h > 23 {
			continue
		}
		utc[h] += parsePanelInt(row.Values[1])
	}
	var local [24]int64
	var total int64
	for h := range 24 {
		lh := ((h+offsetHours)%24 + 24) % 24
		local[lh] += utc[h]
		total += utc[h]
	}
	labels := make([]string, 24)
	values := make([]float64, 24)
	peakHour := 0
	var peakVal int64
	for h := range 24 {
		labels[h] = fmt.Sprintf("%02dh", h)
		values[h] = float64(local[h])
		if local[h] > peakVal {
			peakVal = local[h]
			peakHour = h
		}
	}
	peakLabel := "no activity"
	if total > 0 {
		peakLabel = fmt.Sprintf("peak %02dh local", peakHour)
	}
	return hourChartView{
		Chart: charts.Spec{
			Type:        "line",
			Labels:      labels,
			Datasets:    []charts.Dataset{{Name: "sessions", Values: values}},
			RegionFill:  true,
			ValueSuffix: " sessions",
			Height:      160,
		},
		PeakLabel: peakLabel,
	}
}

// issueRow is one actionable entry in the Issues recent list: a pre-rendered
// agent badge and project link, the timestamp, and a deep link that opens the
// flagged session's transcript.
type issueRow struct {
	Agent   template.HTML
	Project template.HTML
	When    string
	URL     string
}

// issuesView powers the Issues section: an error-rate indicator, the top
// error-prone model, an errors-per-model leaderboard, and the recent flagged
// sessions. All built from the heuristic error reports — honestly a content
// heuristic, not structured failures.
type issuesView struct {
	Flagged      int64
	Rate         string
	TopModel     string
	PerModelBars []barRow
	Recent       []issueRow
}

// buildIssues derives the Issues section from errors_by_model (the full
// per-model flagged counts) and errors (the recent-rows list), plus the total
// session count for the rate.
func buildIssues(errModelRows, errRows []*prosav1.AnalyticsRow, totalSessions int64) issuesView {
	flagged := flaggedTotal(errModelRows)
	var topCount int64
	topModel := ""
	for _, row := range errModelRows {
		if len(row.Values) < 2 {
			continue
		}
		if c := parsePanelInt(row.Values[1]); c > topCount {
			topCount = c
			topModel = strings.TrimSpace(row.Values[0])
		}
	}
	rate := "0%"
	if totalSessions > 0 {
		rate = fmt.Sprintf("%.0f%%", errorRatePct(flagged, totalSessions))
	}
	if topModel == "" {
		topModel = "—"
	}
	recentRows := clampRows(errRows, 8)
	recent := make([]issueRow, 0, len(recentRows))
	for _, row := range recentRows {
		if len(row.Values) < 4 {
			continue
		}
		id := strings.TrimSpace(row.Values[3])
		recent = append(recent, issueRow{
			Agent:   agentBadge(row.Values[1]),
			Project: projectLink(projectDisplayFromLabel(row.Values[2])),
			When:    row.Values[0],
			URL:     "/sessions?session=" + url.QueryEscape(id),
		})
	}
	return issuesView{
		Flagged:      flagged,
		Rate:         rate,
		TopModel:     topModel,
		PerModelBars: buildBarRows(errModelRows, 8),
		Recent:       recent,
	}
}

// flaggedTotal sums the per-model flagged-session counts of an errors_by_model report.
func flaggedTotal(rows []*prosav1.AnalyticsRow) int64 {
	var flagged int64
	for _, row := range rows {
		if len(row.Values) < 2 {
			continue
		}
		flagged += parsePanelInt(row.Values[1])
	}
	return flagged
}

// errorRatePct is the error-rate percentage (0..100); zero sessions yield zero.
func errorRatePct(flagged, totalSessions int64) float64 {
	if totalSessions <= 0 {
		return 0
	}
	return float64(flagged) / float64(totalSessions) * 100
}

// kpiView is one entry of the KPI strip: a value plus an optional delta badge.
type kpiView struct {
	Value string
	Label string
	Delta *kpiDelta
}

// kpiDelta is the movement badge beside a KPI value.
type kpiDelta struct {
	Text string // "+12%", "-8%", "0%", "new"
	Dir  string // "up" | "down" | "flat"
	Tone string // "good" | "bad" | "muted"
}

// deltaTone says how to read a KPI's movement direction.
type deltaTone int

const (
	deltaUpGood  deltaTone = iota // more is better (sessions, tokens, …)
	deltaUpBad                    // more is worse (error rate)
	deltaNeutral                  // informational (est. spend)
)

// buildKPIDelta compares a KPI against the previous window. Nil when both
// windows are zero; "new" when the metric only exists in the current window.
func buildKPIDelta(curr, prev float64, tone deltaTone) *kpiDelta {
	if curr == 0 && prev == 0 {
		return nil
	}
	d := &kpiDelta{}
	if prev == 0 {
		d.Text = "new"
		d.Dir = "up"
	} else {
		pct := int(math.Round((curr - prev) / prev * 100))
		d.Text = fmt.Sprintf("%+d%%", pct)
		switch {
		case pct > 0:
			d.Dir = "up"
		case pct < 0:
			d.Dir = "down"
		default:
			d.Dir = "flat"
		}
	}
	switch {
	case tone == deltaNeutral || d.Dir == "flat":
		d.Tone = "muted"
	case (d.Dir == "up") == (tone == deltaUpGood):
		d.Tone = "good"
	default:
		d.Tone = "bad"
	}
	return d
}

// trendView powers the Activity trend card: sessions per day/week stacked by agent.
type trendView struct {
	Chart       charts.Spec
	Legend      []shareLegendRow
	StartLabel  string
	EndLabel    string
	BucketLabel string // "per day" | "per week"
	Total       int64
	HasData     bool
}

// buildActivityTrend folds windowed heatmap rows into per-agent stacked
// columns; agents past the palette's reach collapse into "other".
func buildActivityTrend(rows []*prosav1.AnalyticsRow) trendView {
	type key struct{ day, agent string }
	counts := map[key]int64{}
	agentTotals := map[string]int64{}
	days := []string{}
	seenDay := map[string]bool{}
	var total int64
	for _, row := range rows {
		if len(row.Values) < 3 || row.Values[0] == "" {
			continue
		}
		day := row.Values[0]
		if !seenDay[day] {
			seenDay[day] = true
			days = append(days, day)
		}
		agent := strings.TrimSpace(row.Values[1])
		n := parsePanelInt(row.Values[2])
		if agent == "" || n <= 0 {
			continue
		}
		counts[key{day, agent}] += n
		agentTotals[agent] += n
		total += n
	}
	if len(days) == 0 {
		return trendView{BucketLabel: "per day"}
	}
	sort.Strings(days)

	agents := make([]string, 0, len(agentTotals))
	for a := range agentTotals {
		agents = append(agents, a)
	}
	sort.Slice(agents, func(i, j int) bool {
		if agentTotals[agents[i]] == agentTotals[agents[j]] {
			return agents[i] < agents[j]
		}
		return agentTotals[agents[i]] > agentTotals[agents[j]]
	})
	top := agents
	hasOther := false
	if len(agents) > modelShareTopN {
		top = agents[:modelShareTopN]
		hasOther = true
	}

	weekly := len(days) > weeklyBucketCutoverDays
	bucketLabel := "per day"
	if weekly {
		bucketLabel = "per week"
	}
	labels := []string{}
	bucketIdx := map[string]int{}
	for _, day := range days {
		label := day[5:]
		if weekly {
			label = weekStartLabel(day)
		}
		if n := len(labels); n == 0 || labels[n-1] != label {
			labels = append(labels, label)
		}
		bucketIdx[day] = len(labels) - 1
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
	for _, a := range top {
		values := make([]float64, len(labels))
		for _, day := range days {
			values[bucketIdx[day]] += float64(counts[key{day, a}])
		}
		addSeries(a, agentTotals[a], values)
	}
	if hasOther {
		values := make([]float64, len(labels))
		var otherTotal int64
		for _, a := range agents[modelShareTopN:] {
			otherTotal += agentTotals[a]
			for _, day := range days {
				values[bucketIdx[day]] += float64(counts[key{day, a}])
			}
		}
		addSeries("other", otherTotal, values)
	}

	return trendView{
		Chart: charts.Spec{
			Type:        "bar",
			Labels:      labels,
			Datasets:    datasets,
			Stacked:     true,
			ValueSuffix: " sessions",
			Height:      180,
		},
		Legend:      legend,
		StartLabel:  labels[0],
		EndLabel:    labels[len(labels)-1],
		BucketLabel: bucketLabel,
		Total:       total,
		HasData:     total > 0,
	}
}
