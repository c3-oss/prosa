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
// Tokens* are comma-grouped strings, StartedAt* are display timestamps.
type sessionRow struct {
	Id              string
	Agent           string
	ProjectLabel    string
	ProjectURL      string
	ProjectProvider string
	FirstPrompt     string
	FirstPromptFull string
	TokensTotal     string
	TokensTotalFull string
	TokensIn        string
	TokensOut       string
	Cost            string
	Device          string
	StartedAt       string
	StartedAtFull   string
	StartedRel      string
	OpenURL         string
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
	sortDirRaw := q.Get("dir")
	activeSort, activeDir := resolveSessionsSort(sortBy, sortDirRaw)
	queryStr := strings.TrimSpace(q.Get("q"))

	// Page (1-based) → offset.
	page, _ := strconv.Atoi(q.Get("page"))
	if page < 1 {
		page = 1
	}

	baseReq := &prosav1.ListRequest{
		Since:       timestamppb.New(since),
		Until:       timestamppb.New(until),
		DeviceNames: devices,
		Query:       queryStr,
	}
	if len(agents) == 1 {
		baseReq.Agent = agents[0]
	}
	if len(projects) >= 1 {
		baseReq.ProjectMatch = projects[0]
	}

	var (
		sessions  []*prosav1.Session
		total     int64
		pageCount int
		err       error
	)
	if sortBy == "cost" && queryStr == "" {
		sessions, total, pageCount, err = p.listSessionsSortedByCost(r.Context(), baseReq, agents, projects, page, activeDir)
	} else {
		serverSort := sortBy
		if sortBy == "cost" {
			serverSort = ""
		}
		req := cloneListRequest(baseReq)
		req.Limit = int32(sessionsPageLimit)
		req.Offset = int32((page - 1) * sessionsPageLimit)
		req.SortBy = serverSort
		req.SortDir = sortDirRaw
		resp, listErr := p.clients.Sessions.List(r.Context(), connect.NewRequest(req))
		if listErr != nil {
			err = listErr
		} else {
			sessions = resp.Msg.Sessions
			if len(agents) > 1 {
				sessions = filterByAgents(sessions, agents)
			}
			if len(projects) > 1 {
				sessions = filterByProjects(sessions, projects)
			}
			total = resp.Msg.TotalCount
			pageCount = int((total + int64(sessionsPageLimit) - 1) / int64(sessionsPageLimit))
			if pageCount < 1 {
				pageCount = 1
			}
			if page > pageCount {
				page = pageCount
			}
		}
	}
	if err != nil {
		slog.Error("sessions.list failed", "err", err)
		http.Error(w, "list failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	if page > pageCount {
		page = pageCount
	}

	// Column chooser. Default omits the verbose id column.
	cols := buildColsMap(pickMulti(q, "cols"))

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
	base := stripQuery(r.URL.Query(), "page", "sort", "dir", "session")
	sortURLs := buildSessionsSortURLs(base, activeSort, activeDir)
	sortArrows := buildSessionsSortArrows(activeSort, activeDir)
	prevURL := ""
	nextURL := ""
	if page > 1 {
		prevURL = "?" + appendKey(stripQuery(r.URL.Query(), "page"), "page", strconv.Itoa(page-1))
	}
	if page < pageCount {
		nextURL = "?" + appendKey(stripQuery(r.URL.Query(), "page"), "page", strconv.Itoa(page+1))
	}

	activeFilters := buildSessionsActiveFilters(r.URL.Query(), queryStr, lastRaw, agents, projects, devices)
	clearURL := ""
	if len(activeFilters) > 0 {
		clearURL = "/sessions"
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
		"Dir":              sortDirRaw,
		"Cols":             cols,
		"Sessions":         rows,
		"Page":             page,
		"PageCount":        pageCount,
		"TotalCount":       total,
		"PrevURL":          prevURL,
		"NextURL":          nextURL,
		"SortURLs":         sortURLs,
		"SortArrows":       sortArrows,
		"ActiveFilters":    activeFilters,
		"ClearFiltersURL":  clearURL,
		"WindowLabel":      windowLabel(lastRaw),
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

// activeFilter is one chip in the "what's narrowing the result set"
// row above the table. RemoveURL drops just this filter and resets
// the page so the user lands on a coherent set; Label/Value carry
// the rendered text.
type activeFilter struct {
	Label     string
	Value     string
	RemoveURL string
}

// buildSessionsActiveFilters renders the current filter state as a
// slice of chips. Window stays visible only when the user picked
// something other than the default (30d). Multi-select dimensions
// (agent, project, device) emit one chip per selected value so a click
// removes exactly that value rather than the whole dimension.
func buildSessionsActiveFilters(q url.Values, queryStr, last string, agents, projects, devices []string) []activeFilter {
	var out []activeFilter
	mk := func(label, value string, removeQuery url.Values) activeFilter {
		// Page resets on any filter change so the user lands at row 1
		// of the narrower result set.
		removeQuery.Del("page")
		removeQuery.Del("session")
		removeURL := "/sessions"
		if encoded := removeQuery.Encode(); encoded != "" {
			removeURL += "?" + encoded
		}
		return activeFilter{Label: label, Value: value, RemoveURL: removeURL}
	}
	if queryStr != "" {
		next := cloneValues(q)
		next.Del("q")
		out = append(out, mk("Search", queryStr, next))
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

// removeFromMulti drops exactly one occurrence of value from the slice
// behind q[key]. Used by the active-filter chips so clicking × on
// "agent: codex" while "agent: claude" is also active drops just the
// codex chip.
func removeFromMulti(q url.Values, key, value string) {
	vals := q[key]
	kept := vals[:0]
	for _, v := range vals {
		if v != value {
			kept = append(kept, v)
		}
	}
	if len(kept) == 0 {
		q.Del(key)
	} else {
		q[key] = kept
	}
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

// buildColsMap turns repeated cols query params into a map of known
// column keys → enabled. Empty input picks the default cols (id omitted).
func buildColsMap(cols []string) map[string]bool {
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
	if len(cols) == 0 {
		return defaults
	}
	out := make(map[string]bool, len(known))
	for _, k := range known {
		out[k] = false
	}
	for _, v := range cols {
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

const sessionsListBatch = 1000

type costSortRow struct {
	session *prosav1.Session
	cost    float64
	ok      bool
}

// listSessionsSortedByCost loads every session matching the filter set,
// applies multi-select post-filters, sorts by estimated cost in the given
// direction, then returns one page slice.
func (p *Panel) listSessionsSortedByCost(
	ctx context.Context,
	base *prosav1.ListRequest,
	agents, projects []string,
	page int,
	costDir string,
) ([]*prosav1.Session, int64, int, error) {
	var all []*prosav1.Session
	offset := int32(0)
	for {
		req := cloneListRequest(base)
		req.Limit = sessionsListBatch
		req.Offset = offset
		req.SortBy = ""
		resp, err := p.clients.Sessions.List(ctx, connect.NewRequest(req))
		if err != nil {
			return nil, 0, 0, err
		}
		batch := resp.Msg.Sessions
		all = append(all, batch...)
		if len(batch) < sessionsListBatch {
			break
		}
		offset += sessionsListBatch
		if int64(offset) >= resp.Msg.TotalCount {
			break
		}
	}
	if len(agents) > 1 {
		all = filterByAgents(all, agents)
	}
	if len(projects) > 1 {
		all = filterByProjects(all, projects)
	}
	rows := make([]costSortRow, len(all))
	for i, s := range all {
		usage := tokenUsageFromProto(s.Usage)
		cost, ok := pricing.CostUSD(s.Model, usage)
		rows[i] = costSortRow{session: s, cost: cost, ok: ok}
	}
	costDesc := costDir != "asc"
	sort.SliceStable(rows, func(i, j int) bool {
		ri, rj := rows[i], rows[j]
		if ri.ok != rj.ok {
			return ri.ok
		}
		if ri.cost != rj.cost {
			if costDesc {
				return ri.cost > rj.cost
			}
			return ri.cost < rj.cost
		}
		ti := sessionStartedAt(ri.session)
		tj := sessionStartedAt(rj.session)
		if costDesc {
			return ti.After(tj)
		}
		return ti.Before(tj)
	})
	total := int64(len(rows))
	pageCount := int((total + int64(sessionsPageLimit) - 1) / int64(sessionsPageLimit))
	if pageCount < 1 {
		pageCount = 1
	}
	if page > pageCount {
		page = pageCount
	}
	start := (page - 1) * sessionsPageLimit
	end := start + sessionsPageLimit
	if start > len(rows) {
		start = len(rows)
	}
	if end > len(rows) {
		end = len(rows)
	}
	out := make([]*prosav1.Session, 0, end-start)
	for _, r := range rows[start:end] {
		out = append(out, r.session)
	}
	return out, total, pageCount, nil
}

func sessionStartedAt(s *prosav1.Session) time.Time {
	if s == nil || s.StartedAt == nil {
		return time.Time{}
	}
	return s.StartedAt.AsTime()
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
		costLabel = fmt.Sprintf("$%.2f", cost)
	}
	startedFull := ""
	startedRel := ""
	if s.StartedAt != nil {
		t := s.StartedAt.AsTime().In(time.Local)
		startedFull = t.Format("2006-01-02 15:04:05")
		startedRel = relativeTime(t)
	}
	device := s.DeviceId
	if name, ok := deviceLookup[s.DeviceId]; ok && name != "" {
		device = name
	}
	proj := projectDisplayFromSession(s)
	openVals := cloneValues(current.Query())
	openVals.Set("session", s.Id)
	openURL := current.Path + "?" + openVals.Encode()
	return sessionRow{
		Id:              s.Id,
		Agent:           s.Agent,
		ProjectLabel:    proj.Label,
		ProjectURL:      proj.URL,
		ProjectProvider: proj.Provider,
		FirstPrompt:     s.FirstPrompt,
		FirstPromptFull: s.FirstPrompt,
		TokensTotal:     formatTokensCompact(usage.TotalTokens),
		TokensTotalFull: formatPanelInt(usage.TotalTokens),
		TokensIn:        formatPanelInt(usage.InputTokens),
		TokensOut:       formatPanelInt(usage.OutputTokens),
		Cost:            costLabel,
		Device:          device,
		StartedAt:       startedRel,
		StartedAtFull:   startedFull,
		StartedRel:      startedRel,
		OpenURL:         openURL,
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

// cloneListRequest copies a ListRequest without copying the embedded
// proto mutex (go vet -copylocks).
func cloneListRequest(in *prosav1.ListRequest) *prosav1.ListRequest {
	if in == nil {
		return &prosav1.ListRequest{}
	}
	out := &prosav1.ListRequest{
		Since:         in.Since,
		Until:         in.Until,
		ProjectPath:   in.ProjectPath,
		ProjectMatch:  in.ProjectMatch,
		ProjectRemote: in.ProjectRemote,
		ProjectMarker: in.ProjectMarker,
		Agent:         in.Agent,
		DeviceName:    in.DeviceName,
		Query:         in.Query,
		SortBy:        in.SortBy,
		SortDir:       in.SortDir,
		Limit:         in.Limit,
		Offset:        in.Offset,
	}
	if len(in.DeviceNames) > 0 {
		out.DeviceNames = append([]string(nil), in.DeviceNames...)
	}
	return out
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
