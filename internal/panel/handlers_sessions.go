package panel

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/pricing"
	"github.com/c3-oss/prosa/pkg/session"
)

// panelAgents is the hardcoded agent list the panel uses to populate
// the Sessions filter dropdown. Mirrors the slice used inline in
// handleAnalytics; declared here so we don't have to widen the
// analytics handler's signature just to share it.
var panelAgents = []string{"codex", "claude-code", "gemini", "antigravity", "hermes", "cursor"}

// sessionsPageLimit is the fixed page size for the Sessions list.
// Per the plan, configurability is deferred until a real call site
// asks for it.
const sessionsPageLimit = 50

// sessionRow is one row of the Sessions table, pre-formatted for the
// template so the view stays declarative. Cost is "$x.xx" or "n/a",
// Tokens* are comma-grouped strings, StartedAt is local time.
type sessionRow struct {
	Id           string
	Agent        string
	ProjectLabel string
	FirstPrompt  string
	TokensTotal  string
	TokensIn     string
	TokensOut    string
	Cost         string
	Device       string
	StartedAt    string
	OpenURL      string
}

// handleSessions renders the Sessions surface: FTS search, multi-select
// filters, sortable headers, column chooser, paginated table. URL
// querystring carries every piece of state so views are bookmarkable.
func (p *Panel) handleSessions(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	// Window: "12h"/"7d"/"30d"/"365d" go through parseWindow; "all"
	// uses a deliberately huge window so the server's required since/
	// until bounds are satisfied without us inventing a new RPC shape.
	lastRaw := q.Get("last")
	if lastRaw == "" {
		lastRaw = "30d"
	}
	now := time.Now().UTC()
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

	// Filters.
	agents := pickMulti(q, "agent")
	projects := pickMulti(q, "project")
	devices := pickDeviceNames(q)
	sortBy := q.Get("sort")
	queryStr := strings.TrimSpace(q.Get("q"))

	// Page (1-based) → offset.
	page, _ := strconv.Atoi(q.Get("page"))
	if page < 1 {
		page = 1
	}

	// Build the ListRequest. project_match accepts at most one value;
	// when the user picked multiple projects, the first goes server-side
	// and the rest get filtered in-process below. The dataset is small
	// enough (single-user, indexed Postgres) that this stays cheap.
	req := &prosav1.ListRequest{
		Since:       timestamppb.New(since),
		Until:       timestamppb.New(until),
		Limit:       int32(sessionsPageLimit),
		Offset:      int32((page - 1) * sessionsPageLimit),
		DeviceNames: devices,
		Query:       queryStr,
		SortBy:      sortBy,
	}
	// agent is single-valued server-side. With multiple agents
	// selected, drop the server-side filter and post-filter the page
	// (matches the same single-tenant trade-off as project_match).
	if len(agents) == 1 {
		req.Agent = agents[0]
	}
	if len(projects) >= 1 {
		req.ProjectMatch = projects[0]
	}

	resp, err := p.clients.Sessions.List(r.Context(), connect.NewRequest(req))
	if err != nil {
		slog.Error("sessions.list failed", "err", err)
		http.Error(w, "list failed: "+err.Error(), http.StatusBadGateway)
		return
	}

	// In-process narrowing for the "more than one" multi-select cases.
	// Pure client-side trim of the already-returned page; doesn't try
	// to re-query the server. Documented limitation: the page count
	// computed from TotalCount may overstate when these post-filters
	// remove rows. Acceptable for v1 (cardinality is tiny).
	sessions := resp.Msg.Sessions
	if len(agents) > 1 {
		sessions = filterByAgents(sessions, agents)
	}
	if len(projects) > 1 {
		sessions = filterByProjects(sessions, projects)
	}

	// Pagination math (clamped). TotalCount is unaware of the in-
	// process trim above, but it's the right denominator for the
	// server-side filter set.
	total := resp.Msg.TotalCount
	pageCount := int((total + int64(sessionsPageLimit) - 1) / int64(sessionsPageLimit))
	if pageCount < 1 {
		pageCount = 1
	}
	if page > pageCount {
		page = pageCount
	}

	// Column chooser. Default omits the verbose id column.
	colsRaw := strings.TrimSpace(q.Get("cols"))
	cols := buildColsMap(colsRaw)

	// Dropdown option lists. Devices come from Devices.List; projects
	// come from the analytics "projects" report scoped to the same
	// window so the dropdown stays roughly relevant. Failures here
	// degrade the dropdown to empty rather than 502 the page.
	deviceNames, deviceLookup, err := p.loadDeviceLookup(r.Context())
	if err != nil {
		slog.Warn("sessions devices.list failed", "err", err)
	}
	projectNames, err := p.listProjectLabels(r.Context(), since, until)
	if err != nil {
		slog.Warn("sessions projects.list failed", "err", err)
	}

	// Selection maps for the template (`index .X "k"`).
	agentsSelected := selectionSet(agents)
	projectsSelected := selectionSet(projects)
	devicesSelected := selectionSet(devices)

	// Pre-build rows with display-formatted strings.
	rows := make([]sessionRow, 0, len(sessions))
	for _, s := range sessions {
		rows = append(rows, buildSessionRow(s, r.URL, deviceLookup))
	}

	// URL helpers: BaseQuery preserves the current filter set so links
	// can append `&sort=` or `&page=` without re-encoding. SortURLs map
	// header click targets to ?sort=<col>; prev/next pre-flip the
	// page param.
	base := stripQuery(r.URL.Query(), "page", "sort", "session")
	sortURLs := map[string]string{
		"started_at":   "?" + appendKey(base, "sort", "started_at"),
		"total_tokens": "?" + appendKey(base, "sort", "total_tokens"),
	}
	prevURL := ""
	nextURL := ""
	if page > 1 {
		prevURL = "?" + appendKey(stripQuery(r.URL.Query(), "page"), "page", strconv.Itoa(page-1))
	}
	if page < pageCount {
		nextURL = "?" + appendKey(stripQuery(r.URL.Query(), "page"), "page", strconv.Itoa(page+1))
	}

	data := map[string]any{
		"Title":            "Sessions",
		"Nav":              "sessions",
		"Q":                queryStr,
		"Last":             lastRaw,
		"Agents":           panelAgents,
		"AgentsSelected":   agentsSelected,
		"Projects":         projectNames,
		"ProjectsSelected": projectsSelected,
		"Devices":          deviceNames,
		"DevicesSelected":  devicesSelected,
		"Sort":             sortBy,
		"Cols":             cols,
		"Sessions":         rows,
		"Page":             page,
		"PageCount":        pageCount,
		"TotalCount":       total,
		"PrevURL":          prevURL,
		"NextURL":          nextURL,
		"SortURLs":         sortURLs,
	}

	// Side panel inline render when ?session=<id> — same pattern as
	// handleHome so the HTMX swap and the bookmarked-deep-link path
	// share one rendering codepath.
	if sid := q.Get("session"); sid != "" {
		sp, err := p.loadSidePanel(r.Context(), sid)
		if err != nil {
			slog.Warn("side panel load failed", "id", sid, "err", err)
		} else {
			data["SidePanel"] = sp
		}
	}
	p.render(w, "sessions", data)
}

// pickMulti returns every non-empty value for key, trimmed.
func pickMulti(q url.Values, key string) []string {
	vals := q[key]
	out := make([]string, 0, len(vals))
	for _, v := range vals {
		v = strings.TrimSpace(v)
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}

// selectionSet folds a slice into the map[string]bool the template
// uses via `index $.XSelected .`.
func selectionSet(in []string) map[string]bool {
	out := make(map[string]bool, len(in))
	for _, v := range in {
		out[v] = true
	}
	return out
}

// buildColsMap turns the comma-separated cols param into a map of
// known column keys → enabled. Empty input picks the default cols
// (id omitted).
func buildColsMap(cols string) map[string]bool {
	known := []string{"agent", "project", "first_prompt", "tokens", "cost", "device", "id"}
	defaults := map[string]bool{
		"agent":        true,
		"project":      true,
		"first_prompt": true,
		"tokens":       true,
		"cost":         true,
		"device":       true,
		"id":           false,
	}
	if cols == "" {
		return defaults
	}
	out := make(map[string]bool, len(known))
	for _, k := range known {
		out[k] = false
	}
	for _, v := range strings.Split(cols, ",") {
		v = strings.TrimSpace(v)
		if _, ok := out[v]; ok {
			out[v] = true
		}
	}
	return out
}

// filterByAgents narrows in-place to sessions whose Agent is in the
// allowed set. Order preserved.
func filterByAgents(sessions []*prosav1.Session, allowed []string) []*prosav1.Session {
	set := map[string]bool{}
	for _, a := range allowed {
		set[a] = true
	}
	out := sessions[:0]
	for _, s := range sessions {
		if set[s.Agent] {
			out = append(out, s)
		}
	}
	return out
}

// filterByProjects narrows in-place to sessions whose computed project
// label contains (substring) any of the allowed project tokens. Mirrors
// the server's project_match LIKE semantics.
func filterByProjects(sessions []*prosav1.Session, allowed []string) []*prosav1.Session {
	out := sessions[:0]
	for _, s := range sessions {
		label := sessionProjectLabel(s)
		for _, a := range allowed {
			if strings.Contains(label, a) {
				out = append(out, s)
				break
			}
		}
	}
	return out
}

// sessionProjectLabel mirrors the home template's
// `or .ProjectMarker .ProjectRemote .ProjectPath "(unscoped)"` so the
// table cell, the dropdown options, and the filter step agree.
func sessionProjectLabel(s *prosav1.Session) string {
	if s == nil {
		return "(unscoped)"
	}
	if s.ProjectMarker != "" {
		return s.ProjectMarker
	}
	if s.ProjectRemote != "" {
		return s.ProjectRemote
	}
	if s.ProjectPath != "" {
		return s.ProjectPath
	}
	return "(unscoped)"
}

// buildSessionRow projects one *prosav1.Session into the row shape the
// template renders. The OpenURL preserves the current querystring and
// adds ?session=<id> so clicking a row keeps every filter intact.
// deviceLookup maps device IDs to friendly names so the table shows the
// human label instead of an opaque UUID; falls back to the raw ID when
// the device isn't in the lookup.
func buildSessionRow(s *prosav1.Session, current *url.URL, deviceLookup map[string]string) sessionRow {
	if s == nil {
		return sessionRow{}
	}
	usage := tokenUsageFromProto(s.Usage)
	costLabel := "n/a"
	if cost, ok := pricing.CostUSD(s.Model, usage); ok {
		costLabel = fmt.Sprintf("$%.4f", cost)
	}
	startedAt := ""
	if s.StartedAt != nil {
		startedAt = s.StartedAt.AsTime().In(time.Local).Format("2006-01-02 15:04")
	}
	device := s.DeviceId
	if name, ok := deviceLookup[s.DeviceId]; ok && name != "" {
		device = name
	}
	// OpenURL: same path + querystring + &session=<id>, replacing any
	// prior session value so successive clicks don't pile up params.
	openVals := cloneValues(current.Query())
	openVals.Set("session", s.Id)
	openURL := current.Path + "?" + openVals.Encode()
	return sessionRow{
		Id:           s.Id,
		Agent:        s.Agent,
		ProjectLabel: sessionProjectLabel(s),
		FirstPrompt:  s.FirstPrompt,
		TokensTotal:  formatPanelInt(usage.TotalTokens),
		TokensIn:     formatPanelInt(usage.InputTokens),
		TokensOut:    formatPanelInt(usage.OutputTokens),
		Cost:         costLabel,
		Device:       device,
		StartedAt:    startedAt,
		OpenURL:      openURL,
	}
}

// loadDeviceLookup returns the dropdown-ready sorted list of device
// friendly names together with a Map[deviceID]→friendlyName lookup so
// row rendering can show the human label instead of the raw UUID. A
// single Devices.List RPC covers both surfaces.
func (p *Panel) loadDeviceLookup(ctx context.Context) ([]string, map[string]string, error) {
	resp, err := p.clients.Devices.List(ctx, connect.NewRequest(&prosav1.DevicesServiceListRequest{}))
	if err != nil {
		return nil, nil, err
	}
	names := make([]string, 0, len(resp.Msg.Devices))
	lookup := make(map[string]string, len(resp.Msg.Devices))
	for _, d := range resp.Msg.Devices {
		name := d.FriendlyName
		if name == "" {
			name = d.Id
		}
		names = append(names, name)
		lookup[d.Id] = name
	}
	sort.Strings(names)
	return names, lookup, nil
}

// tokenUsageFromProto reshapes the proto-side TokenUsage into the
// pkg/session.TokenUsage shape pricing.CostUSD expects. Returns a zero
// value when the proto pointer is nil so the cost path still runs and
// returns priced=false uniformly.
func tokenUsageFromProto(u *prosav1.TokenUsage) session.TokenUsage {
	if u == nil {
		return session.TokenUsage{}
	}
	return session.TokenUsage{
		TotalTokens:         u.TotalTokens,
		InputTokens:         u.InputTokens,
		OutputTokens:        u.OutputTokens,
		CachedTokens:        u.CachedTokens,
		CacheReadTokens:     u.CacheReadTokens,
		CacheCreationTokens: u.CacheCreationTokens,
	}
}

// cloneValues returns an independent copy of the URL values map so
// callers can mutate it without bleeding into the caller's source.
func cloneValues(in url.Values) url.Values {
	out := make(url.Values, len(in))
	for k, vs := range in {
		cp := make([]string, len(vs))
		copy(cp, vs)
		out[k] = cp
	}
	return out
}

// stripQuery returns a copy of q with the named keys removed.
// Convenient when composing URLs that need to replace, not add, a
// param (e.g. paging swaps `page`, sorting swaps `sort`).
func stripQuery(q url.Values, keys ...string) url.Values {
	out := cloneValues(q)
	for _, k := range keys {
		out.Del(k)
	}
	return out
}

// appendKey encodes q and appends `key=val` to the end, dropping any
// existing copy of key first. The result is the raw querystring suffix
// (no leading `?`) so callers can compose `?` + appendKey(...).
func appendKey(q url.Values, key, val string) string {
	q.Del(key)
	q.Set(key, val)
	return q.Encode()
}

// listProjectLabels resolves the project dropdown choices by reading
// the analytics "projects" report for the window in play. The first
// column of every row is the human label; dedupe + alpha-sort so the
// dropdown looks tidy. A failure here is non-fatal — the caller logs
// and renders an empty dropdown.
func (p *Panel) listProjectLabels(ctx context.Context, since, until time.Time) ([]string, error) {
	resp, err := p.clients.Analytics.GetReport(ctx, connect.NewRequest(&prosav1.GetReportRequest{
		Report: "projects",
		Since:  timestamppb.New(since),
		Until:  timestamppb.New(until),
	}))
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(resp.Msg.Rows))
	for _, row := range resp.Msg.Rows {
		if len(row.Values) == 0 {
			continue
		}
		label := strings.TrimSpace(row.Values[0])
		if label == "" || seen[label] {
			continue
		}
		seen[label] = true
		out = append(out, label)
	}
	sort.Strings(out)
	return out, nil
}
