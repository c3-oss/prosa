package panel

import (
	"fmt"
	"log/slog"
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

	// Default window 30d — the dashboard wants a roomier rolling view
	// than the CLI's 7d, while still letting the user narrow via ?last=.
	lastRaw := q.Get("last")
	if lastRaw == "" {
		lastRaw = "30d"
	}
	now := nowFn().UTC()
	var since, until time.Time
	until = now
	if lastRaw == "all" {
		since = now.Add(-100 * 365 * 24 * time.Hour)
	} else {
		window, err := parseWindow(lastRaw)
		if err != nil {
			http.Error(w, "bad last= "+err.Error(), http.StatusBadRequest)
			return
		}
		since = now.Add(-window)
	}
	heatmapSince, heatmapUntil := heatmapWindow(now)

	agents := pickMulti(q, "agent")
	projects := pickMulti(q, "project")
	devices := pickDeviceNames(q)

	// Build the shared filter knobs for the four windowed reports
	// (tools, models, errors, usage). Heatmap uses its own request so
	// the fixed-window override doesn't bleed into the others.
	sharedReq := func(report string) *prosav1.GetReportRequest {
		req := &prosav1.GetReportRequest{
			Report:      report,
			Since:       timestamppb.New(since),
			Until:       timestamppb.New(until),
			DeviceNames: devices,
		}
		// agent and project_match are single-valued on the wire; when
		// the user selected multiple, fall back to "any" server-side
		// (no narrowing) — the cards then reflect the full window. A
		// future refinement could post-filter, but for v1 we keep the
		// dashboard honest at the price of less precise multi-selects.
		if len(agents) == 1 {
			req.Agent = agents[0]
		}
		if len(projects) == 1 {
			req.ProjectMatch = projects[0]
		}
		return req
	}
	heatmapReq := &prosav1.GetReportRequest{
		Report:      "heatmap",
		Since:       timestamppb.New(heatmapSince),
		Until:       timestamppb.New(heatmapUntil),
		DeviceNames: devices,
	}
	if len(agents) == 1 {
		heatmapReq.Agent = agents[0]
	}
	if len(projects) == 1 {
		heatmapReq.ProjectMatch = projects[0]
	}

	// Sessions.List with limit=1 returns one row plus the unfiltered
	// total — cheap way to get the "sessions in window" KPI without
	// pulling the whole list.
	sessionsReq := &prosav1.ListRequest{
		Since:       timestamppb.New(since),
		Until:       timestamppb.New(until),
		Limit:       1,
		DeviceNames: devices,
	}
	if len(agents) == 1 {
		sessionsReq.Agent = agents[0]
	}
	if len(projects) == 1 {
		sessionsReq.ProjectMatch = projects[0]
	}

	type fan struct {
		sessions *prosav1.ListResponse
		tools    *prosav1.GetReportResponse
		models   *prosav1.GetReportResponse
		errors   *prosav1.GetReportResponse
		usage    *prosav1.GetReportResponse
		heatmap  *prosav1.GetReportResponse
		projects *prosav1.GetReportResponse // populates Projects KPI + future dropdown
	}
	var out fan
	g, gctx := errgroup.WithContext(r.Context())
	g.Go(func() error {
		resp, err := p.clients.Sessions.List(gctx, connect.NewRequest(sessionsReq))
		if err != nil {
			return fmt.Errorf("sessions.list: %w", err)
		}
		out.sessions = resp.Msg
		return nil
	})
	for _, spec := range []struct {
		name string
		req  *prosav1.GetReportRequest
		dst  **prosav1.GetReportResponse
	}{
		{"tools", sharedReq("tools"), &out.tools},
		{"models", sharedReq("models"), &out.models},
		{"errors", sharedReq("errors"), &out.errors},
		{"usage", sharedReq("usage"), &out.usage},
		{"projects", sharedReq("projects"), &out.projects},
		{"heatmap", heatmapReq, &out.heatmap},
	} {
		spec := spec
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

	// Dropdown options for the hidden filter block.
	deviceNames, _, err := p.loadDeviceLookup(r.Context())
	if err != nil {
		slog.Warn("home devices.list failed", "err", err)
	}
	projectNames := projectLabelsFromRows(out.projects.Rows)

	heatmap := buildHeatmap(out.heatmap.Rows)
	usageRows, usageTokens, usageCost := buildUsage(out.usage.Rows)

	activeFilters := buildHomeActiveFilters(r.URL.Query(), lastRaw, agents, projects, devices)
	clearFiltersURL := ""
	if len(activeFilters) > 0 {
		clearFiltersURL = "/"
	}

	data := map[string]any{
		"Title": "Home",
		"Nav":   "home",
		"CSRF":  p.csrfFromRequest(r),

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

		// KPI strip.
		"SessionsKPI": out.sessions.TotalCount,
		"ProjectsKPI": len(out.projects.Rows),
		"ModelsKPI":   len(out.models.Rows),

		// Heatmap card.
		"HeatmapCells":    heatmap.Cells,
		"HeatmapTotal":    heatmap.Total,
		"HeatmapMax":      heatmap.Max,
		"HeatmapWeekdays": heatmap.Weekdays,
		"HeatmapMonths":   heatmap.Months,
		"HeatmapColumns":  heatmap.Columns,

		// Tools card.
		"ToolHeaders": out.tools.Headers,
		"ToolBars":    buildBarRows(out.tools.Rows, 10),

		// Models card.
		"ModelHeaders": out.models.Headers,
		"ModelBars":    buildBarRows(out.models.Rows, 10),

		// Errors card.
		"ErrorHeaders": out.errors.Headers,
		"ErrorRows":    clampRows(out.errors.Rows, 20),

		// Usage card.
		"UsageRows":        usageRows,
		"UsageTotalTokens": formatPanelInt(usageTokens),
		"UsageTotalCost":   usageCost,
	}
	p.render(w, "home", data)
}

// barRow is a single bar in a horizontal bar leaderboard. Used by the
// Home tools/models cards. Pre-formatted so the template is dumb.
type barRow struct {
	Label   string
	Count   string
	Percent int
}

// buildBarRows turns analytics rows whose first column is the label and
// second column is a count into bar rows, sorted by count desc and
// capped at limit entries. Robust to malformed rows.
func buildBarRows(rows []*prosav1.AnalyticsRow, limit int) []barRow {
	type parsed struct {
		label string
		count int64
	}
	xs := make([]parsed, 0, len(rows))
	var max int64
	for _, row := range rows {
		if len(row.Values) < 2 {
			continue
		}
		label := strings.TrimSpace(row.Values[0])
		if label == "" {
			continue
		}
		count := parsePanelInt(row.Values[1])
		if count <= 0 {
			continue
		}
		xs = append(xs, parsed{label: label, count: count})
		if count > max {
			max = count
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
		out = append(out, barRow{
			Label:   x.label,
			Count:   formatPanelInt(x.count),
			Percent: percent,
		})
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

// buildHomeActiveFilters mirrors buildSessionsActiveFilters for the
// dashboard. Renders one chip per active filter pointing at "/" so the
// remove URL is bookmark-stable.
func buildHomeActiveFilters(q url.Values, last string, agents, projects, devices []string) []activeFilter {
	var out []activeFilter
	mk := func(label, value string, removeQuery url.Values) activeFilter {
		removeQuery.Del("session")
		removeURL := "/"
		if encoded := removeQuery.Encode(); encoded != "" {
			removeURL += "?" + encoded
		}
		return activeFilter{Label: label, Value: value, RemoveURL: removeURL}
	}
	if last != "" && last != "30d" {
		next := cloneValues(q)
		next.Del("last")
		out = append(out, mk("Window", last, next))
	}
	for _, a := range agents {
		next := cloneValues(q)
		removeFromMulti(next, "agent", a)
		out = append(out, mk("Agent", a, next))
	}
	for _, p := range projects {
		next := cloneValues(q)
		removeFromMulti(next, "project", p)
		out = append(out, mk("Project", p, next))
	}
	for _, d := range devices {
		next := cloneValues(q)
		removeFromMulti(next, "device", d)
		out = append(out, mk("Device", d, next))
	}
	return out
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

func buildUsage(rows []*prosav1.AnalyticsRow) ([]usagePanelRow, int64, string) {
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
	if !priced {
		return out, totalTokens, "n/a"
	}
	return out, totalTokens, fmt.Sprintf("$%.2f", totalCost)
}
