package panel

import (
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"connectrpc.com/connect"
	"golang.org/x/sync/errgroup"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/pricing"
	"github.com/c3-oss/prosa/pkg/session"
)

// handleProfiles renders the profiles dashboard: KPI strip, sessions-per-
// profile trend, tokens & cost per profile, and the enriched device ×
// agent × profile table, each cell linking into a filtered /sessions view.
// Shares the dashboard filter chrome with Home and Insights.
func (p *Panel) handleProfiles(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	now := nowFn().UTC()
	lastRaw, defaultLast := p.resolvePageWindow(r, windowPageProfiles)
	since, until, err := parseDashboardWindow(lastRaw, now)
	if err != nil {
		http.Error(w, "bad last= "+err.Error(), http.StatusBadRequest)
		return
	}

	trendSince := since
	trendClamped := false
	if c := now.AddDate(0, 0, -insightsTrendClampDays); lastRaw == "all" && c.After(trendSince) {
		trendSince = c
		trendClamped = true
	}

	agents := pickMulti(q, "agent")
	projects := pickMulti(q, "project")
	devices := pickDeviceNames(q)
	profilesSel := pickMulti(q, "profile")

	type fan struct {
		usage    *prosav1.GetReportResponse // KPIs + per-profile cards + table
		byDay    *prosav1.GetReportResponse // sessions-per-profile trend
		projects *prosav1.GetReportResponse // project dropdown options
	}
	var out fan
	g, gctx := errgroup.WithContext(r.Context())
	for _, spec := range []struct {
		name string
		req  *prosav1.GetReportRequest
		dst  **prosav1.GetReportResponse
	}{
		{"profile_usage", dashboardReportRequest("profile_usage", since, until, agents, projects, devices, profilesSel), &out.usage},
		{"profiles_by_day", dashboardReportRequest("profiles_by_day", trendSince, until, agents, projects, devices, profilesSel), &out.byDay},
		{"projects", dashboardReportRequest("projects", since, until, agents, projects, devices, profilesSel), &out.projects},
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
		slog.Error("profiles fan-out failed", "err", err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	deviceNames, _, err := p.loadDeviceLookup(r.Context())
	if err != nil {
		slog.Warn("profiles devices.list failed", "err", err)
	}
	projectNames := projectLabelsFromRows(out.projects.Rows)
	profileNames := profileLabelsFromRows(out.usage.Rows)

	windowNote := ""
	if trendClamped {
		windowNote = "trailing 365d"
	}
	usage := buildProfileUsage(out.usage.Rows)
	trend := buildProfileTrend(out.byDay.Rows)

	activeFilters := buildDashboardActiveFilters(r.URL.Query(), "/profiles", lastRaw, defaultLast, agents, projects, devices, profilesSel)
	clearFiltersURL := ""
	if len(activeFilters) > 0 {
		clearFiltersURL = clearFiltersTarget("/profiles", lastRaw, defaultLast)
	}

	p.render(w, r, "profiles", map[string]any{
		"Title":        "Profiles",
		"Nav":          "profiles",
		"CSRF":         p.csrfFromRequest(r),
		"PageTitle":    "Profiles",
		"FilterAction": "/profiles",

		// Filter state.
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

		// Cards.
		"Usage":      usage,
		"Trend":      trend,
		"WindowNote": windowNote,
	})
}

// profilePanelRow is one device × agent × profile line of the profiles
// table, with the per-model rows folded together.
type profilePanelRow struct {
	Device   string
	Agent    string
	Profile  string
	Sessions string
	Tokens   string
	Cost     string
	LastSeen string
}

// profileUsageView powers the profiles dashboard: the KPI strip, the
// tokens-and-cost-per-profile leaderboard, and the enriched table.
type profileUsageView struct {
	ActiveProfiles string
	NonDefaultPct  string
	TotalTokens    string
	TotalSpend     string
	ProfileBars    []profileCostRow
	Rows           []profilePanelRow
	HasData        bool
}

// profileCostRow is one row of the per-profile leaderboard: the agent·profile
// label, its compact token total with a magnitude bar, and the estimated cost
// folded onto the same line (so the bars carry both numbers, no separate donut).
type profileCostRow struct {
	Label   string
	Tokens  string
	Cost    string
	Percent int
}

// buildProfileUsage folds profile_usage rows (one per device × agent ×
// profile × model) into per-profile aggregates. Charts label agent·profile
// (devices folded — the same logical account may sync from several
// devices); the table stays per-device.
func buildProfileUsage(rows []*prosav1.AnalyticsRow) profileUsageView {
	type tableAgg struct {
		row      profilePanelRow
		sessions int64
		tokens   int64
		cost     float64
		priced   bool
		lastSeen string
	}
	tableOrder := []string{}
	table := map[string]*tableAgg{}
	chartOrder := []string{}
	chartTokens := map[string]int64{}
	chartCost := map[string]float64{}
	var totalSessions, nonDefault, totalTokens int64
	var totalCost float64
	priced := false

	for _, row := range rows {
		if len(row.Values) < 13 {
			continue
		}
		device, agent, profile, model := row.Values[0], row.Values[1], row.Values[2], row.Values[3]
		sessions := parsePanelInt(row.Values[4])
		measured := parsePanelInt(row.Values[5])
		usage := session.TokenUsage{
			TotalTokens:         parsePanelInt(row.Values[6]),
			InputTokens:         parsePanelInt(row.Values[7]),
			OutputTokens:        parsePanelInt(row.Values[8]),
			CachedTokens:        parsePanelInt(row.Values[9]),
			CacheReadTokens:     parsePanelInt(row.Values[10]),
			CacheCreationTokens: parsePanelInt(row.Values[11]),
		}
		lastSeen := row.Values[12]

		var cost float64
		rowPriced := false
		if measured > 0 {
			if c, ok := pricing.CostUSD(model, usage); ok {
				cost = c
				rowPriced = true
				priced = true
			}
		}

		totalSessions += sessions
		if profile != session.DefaultProfile {
			nonDefault += sessions
		}
		totalTokens += usage.TotalTokens
		totalCost += cost

		tk := device + "|" + agent + "|" + profile
		agg := table[tk]
		if agg == nil {
			agg = &tableAgg{row: profilePanelRow{Device: device, Agent: agent, Profile: profile}}
			table[tk] = agg
			tableOrder = append(tableOrder, tk)
		}
		agg.sessions += sessions
		agg.tokens += usage.TotalTokens
		agg.cost += cost
		agg.priced = agg.priced || rowPriced
		if lastSeen > agg.lastSeen {
			agg.lastSeen = lastSeen
		}

		ck := agent + "·" + profile
		if _, seen := chartTokens[ck]; !seen {
			chartOrder = append(chartOrder, ck)
		}
		chartTokens[ck] += usage.TotalTokens
		chartCost[ck] += cost
	}

	view := profileUsageView{
		ActiveProfiles: formatPanelInt(int64(len(tableOrder))),
		TotalTokens:    formatTokensCompact(totalTokens),
		TotalSpend:     costLabel(totalCost, priced),
		NonDefaultPct:  "—",
		HasData:        totalSessions > 0,
	}
	if totalSessions > 0 {
		view.NonDefaultPct = fmt.Sprintf("%.0f%%", float64(nonDefault)/float64(totalSessions)*100)
	}

	labels := make([]string, 0, len(chartOrder))
	tokenCounts := make([]int64, 0, len(chartOrder))
	for _, ck := range chartOrder {
		labels = append(labels, ck)
		tokenCounts = append(tokenCounts, chartTokens[ck])
	}
	// One leaderboard: token magnitude bar plus the est. cost on the same row.
	for _, b := range barsFromPairs(labels, tokenCounts, 8, formatTokensCompact) {
		cost := chartCost[b.Label]
		view.ProfileBars = append(view.ProfileBars, profileCostRow{
			Label:   b.Label,
			Tokens:  b.Count,
			Cost:    costLabel(cost, cost > 0),
			Percent: b.Percent,
		})
	}

	for _, tk := range tableOrder {
		agg := table[tk]
		agg.row.Sessions = formatPanelInt(agg.sessions)
		agg.row.Tokens = formatTokensCompact(agg.tokens)
		agg.row.Cost = costLabel(agg.cost, agg.priced)
		agg.row.LastSeen = agg.lastSeen
		view.Rows = append(view.Rows, agg.row)
	}
	return view
}

// buildProfileTrend reshapes profiles_by_day rows (DAY, AGENT, PROFILE,
// SESSIONS) into heatmap-shaped (day, agent·profile, sessions) rows and
// delegates to buildActivityTrend for the stacked weekly fold.
func buildProfileTrend(rows []*prosav1.AnalyticsRow) trendView {
	mapped := make([]*prosav1.AnalyticsRow, 0, len(rows))
	for _, row := range rows {
		if len(row.Values) < 4 {
			continue
		}
		if n, _ := strconv.ParseInt(strings.TrimSpace(row.Values[3]), 10, 64); n <= 0 {
			continue
		}
		mapped = append(mapped, &prosav1.AnalyticsRow{
			Values: []string{row.Values[0], row.Values[1] + "·" + row.Values[2], row.Values[3]},
		})
	}
	return buildActivityTrend(mapped)
}
