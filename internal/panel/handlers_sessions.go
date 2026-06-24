package panel

import (
	"context"
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

// panelKinds is the special-session classification list the Sessions
// Kind filter exposes. Order matches the badge precedence the template
// renders. Mirrors internal/sessionkind's Kind* constants.
var panelKinds = []string{"goal", "workflow", "ralph-loop", "orchestrator"}

// sessionsPageLimitDefault is the default rows-per-page when no
// ?limit= is supplied.
const sessionsPageLimitDefault = 50

// sessionsAllowedLimits whitelists the per-page sizes the filter bar
// exposes. Anything outside the set falls back to the default so an
// unknown ?limit= can't pin pagination to a surprising value.
var sessionsAllowedLimits = []int{25, 50, 100, 200}

// resolveSessionsLimit clamps the requested ?limit= to one of the
// whitelisted values. Empty / invalid / out-of-set inputs return the
// default.
func resolveSessionsLimit(raw string) int {
	if raw == "" {
		return sessionsPageLimitDefault
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return sessionsPageLimitDefault
	}
	for _, v := range sessionsAllowedLimits {
		if v == n {
			return n
		}
	}
	return sessionsPageLimitDefault
}

// sessionRow is one row of the Sessions table, pre-formatted for the
// template so the view stays declarative. Cost is "$x.xx" or "n/a",
// Tokens* are comma-grouped strings, StartedAt* are display timestamps.
// Children, when non-empty, are subagent rows rendered indented under
// this parent; IsChild marks rows rendered inside a parent's expansion
// (used only when group_subagents=off so the flat list can still flag
// them visually).
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
	costAmount      float64
	costPriced      bool
	Device          string
	StartedAt       string
	StartedAtFull   string
	StartedRel      string
	StartedDay      string
	OpenURL         string
	Kinds           []string
	IsChild         bool
	Children        []sessionRow
}

// handleSessions renders the Sessions surface: FTS search, multi-select
// filters, sortable headers, column chooser, paginated table. URL
// querystring carries every piece of state so views are bookmarkable.
func (p *Panel) handleSessions(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	lastRaw, defaultLast := p.resolvePageWindow(r, windowPageSessions)
	now := nowFn().UTC()
	since, until, err := parseDashboardWindow(lastRaw, now)
	if err != nil {
		http.Error(w, "bad last= "+err.Error(), http.StatusBadRequest)
		return
	}

	// Filters.
	agents := pickMulti(q, "agent")
	projects := pickMulti(q, "project")
	devices := pickDeviceNames(q)
	profilesSel := pickMulti(q, "profile")
	kindsSel := pickMulti(q, "kind")
	sortBy := q.Get("sort")
	sortDirRaw := q.Get("dir")
	activeSort, activeDir := resolveSessionsSort(sortBy, sortDirRaw)
	queryStr := strings.TrimSpace(q.Get("q"))
	// Group subagents (default ON). Off via ?group_subagents=off. When
	// on, the listing is filtered to top-level sessions; children are
	// attached to each parent for inline expansion. FTS search disables
	// grouping because the search hit may be inside a child.
	// Read the last value for group_subagents so the hidden+checkbox
	// pattern in the form template works: hidden=off, checkbox=on. When
	// the checkbox is unchecked only "off" is sent; checked sends both
	// in order so the last value ("on") wins. Default ON when absent.
	groupSubagents := lastValueOrDefault(q["group_subagents"], "on") != "off" && queryStr == ""

	// Page (1-based) → offset.
	page, _ := strconv.Atoi(q.Get("page"))
	if page < 1 {
		page = 1
	}
	pageLimit := resolveSessionsLimit(q.Get("limit"))

	baseReq := &prosav1.ListRequest{
		Since:        timestamppb.New(since),
		Until:        timestamppb.New(until),
		DeviceNames:  devices,
		Query:        queryStr,
		TopLevelOnly: groupSubagents,
	}
	// Push the full multi-select to the server so narrowing happens before
	// pagination. Filtering only the current page client-side (the old
	// len==1 path) silently dropped matches on later pages and left the
	// pagination footer showing the unfiltered totals. See issue #79.
	if len(agents) > 0 {
		baseReq.Agents = agents
	}
	if len(projects) > 0 {
		baseReq.ProjectMatches = projects
	}
	if len(profilesSel) > 0 {
		baseReq.Profiles = profilesSel
	}
	if len(kindsSel) > 0 {
		baseReq.Kinds = kindsSel
	}

	var (
		sessions  []*prosav1.Session
		total     int64
		pageCount int
	)
	if sortBy == "cost" && queryStr == "" {
		sessions, total, pageCount, err = p.listSessionsSortedByCost(r.Context(), baseReq, page, pageLimit, activeDir)
	} else {
		serverSort := sortBy
		if sortBy == "cost" {
			serverSort = ""
		}
		req := cloneListRequest(baseReq)
		req.Limit = int32(pageLimit)
		req.Offset = int32((page - 1) * pageLimit)
		req.SortBy = serverSort
		req.SortDir = sortDirRaw
		resp, listErr := p.clients.Sessions.List(r.Context(), connect.NewRequest(req))
		if listErr != nil {
			err = listErr
		} else {
			sessions = resp.Msg.Sessions
			total = resp.Msg.TotalCount
			pageCount = int((total + int64(pageLimit) - 1) / int64(pageLimit))
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
	profileNames, err := p.listProfileLabels(r.Context(), since, until)
	if err != nil {
		slog.Warn("sessions profiles.list failed", "err", err)
	}

	agentsSelected := selectionSet(agents)
	projectsSelected := selectionSet(projects)
	devicesSelected := selectionSet(devices)
	profilesSelected := selectionSet(profilesSel)
	kindsSelected := selectionSet(kindsSel)

	rows := make([]sessionRow, 0, len(sessions))
	for _, s := range sessions {
		rows = append(rows, buildSessionRow(s, r.URL, deviceLookup))
	}
	// When grouping is on, fan out ListChildren for each parent row so
	// the template can render an expandable indented block. Failures
	// degrade silently to a parent without children — the row is still
	// usable on its own.
	if groupSubagents {
		for i := range rows {
			childResp, childErr := p.clients.Sessions.ListChildren(r.Context(),
				connect.NewRequest(&prosav1.ListChildrenRequest{ParentId: rows[i].Id}))
			if childErr != nil {
				slog.Warn("sessions.listChildren failed", "id", rows[i].Id, "err", childErr)
				continue
			}
			for _, child := range childResp.Msg.Sessions {
				childRow := buildSessionRow(child, r.URL, deviceLookup)
				childRow.IsChild = true
				rows[i].Children = append(rows[i].Children, childRow)
			}
			rollUpSessionRowCost(&rows[i])
		}
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

	activeFilters := buildSessionsActiveFilters(r.URL.Query(), queryStr, lastRaw, defaultLast, agents, projects, devices, profilesSel, kindsSel)
	clearURL := ""
	if len(activeFilters) > 0 {
		clearURL = clearFiltersTarget("/sessions", lastRaw, defaultLast)
	}

	data := map[string]any{
		"Title":            "Sessions",
		"Nav":              "sessions",
		"CSRF":             p.csrfFromRequest(r),
		"Q":                queryStr,
		"Last":             lastRaw,
		"DefaultWindow":    defaultLast,
		"Agents":           panelAgents,
		"AgentsSelected":   agentsSelected,
		"Projects":         projectNames,
		"ProjectsSelected": projectsSelected,
		"Devices":          deviceNames,
		"DevicesSelected":  devicesSelected,
		"Profiles":         profileNames,
		"ProfilesSelected": profilesSelected,
		"KindOptions":      panelKinds,
		"KindsSelected":    kindsSelected,
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
		"GroupSubagents":   groupSubagents,
		"PageLimit":        pageLimit,
		"PageSizes":        sessionsAllowedLimits,
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
	p.render(w, r, "sessions", data)
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
// something other than the resolved default. Multi-select dimensions
// (agent, project, device) emit one chip per selected value so a click
// removes exactly that value rather than the whole dimension.
func buildSessionsActiveFilters(q url.Values, queryStr, last, defaultLast string, agents, projects, devices, profilesSel, kindsSel []string) []activeFilter {
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
	if last != "" && last != defaultLast {
		next := cloneValues(q)
		next.Set("last", "")
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
	for _, pr := range profilesSel {
		next := cloneValues(q)
		removeFromMulti(next, "profile", pr)
		out = append(out, mk("Profile", pr, next))
	}
	for _, k := range kindsSel {
		next := cloneValues(q)
		removeFromMulti(next, "kind", k)
		out = append(out, mk("Kind", k, next))
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

// lastValueOrDefault returns the last entry in vals, or the default
// when vals is empty. Used for hidden+checkbox form pairs where the
// checkbox's value should win when present.
func lastValueOrDefault(vals []string, def string) string {
	if len(vals) == 0 {
		return def
	}
	return vals[len(vals)-1]
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

const sessionsListBatch = 1000

type costSortRow struct {
	session *prosav1.Session
	cost    float64
	ok      bool
}

// listSessionsSortedByCost loads every session matching the filter set
// (already narrowed server-side by base's filters), sorts by estimated
// cost in the given direction, then returns one page slice.
func (p *Panel) listSessionsSortedByCost(
	ctx context.Context,
	base *prosav1.ListRequest,
	page, pageLimit int,
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
	rows := make([]costSortRow, len(all))
	includeChildren := base.GetTopLevelOnly()
	for i, s := range all {
		cost, ok := p.sessionCostForSort(ctx, s, includeChildren)
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
	pageCount := int((total + int64(pageLimit) - 1) / int64(pageLimit))
	if pageCount < 1 {
		pageCount = 1
	}
	if page > pageCount {
		page = pageCount
	}
	start := (page - 1) * pageLimit
	end := start + pageLimit
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

func (p *Panel) sessionCostForSort(ctx context.Context, s *prosav1.Session, includeChildren bool) (float64, bool) {
	cost, ok := sessionCost(s)
	if !includeChildren || s == nil {
		return cost, ok
	}
	childResp, err := p.clients.Sessions.ListChildren(ctx,
		connect.NewRequest(&prosav1.ListChildrenRequest{ParentId: s.Id}))
	if err != nil {
		slog.Warn("sessions.listChildren cost sort failed", "id", s.Id, "err", err)
		return cost, ok
	}
	for _, child := range childResp.Msg.Sessions {
		cost, ok = addSessionCost(cost, ok, child)
	}
	return cost, ok
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
	cost, priced := sessionCost(s)
	startedFull := ""
	startedRel := ""
	startedDay := ""
	if s.StartedAt != nil {
		t := s.StartedAt.AsTime().In(time.Local)
		startedFull = t.Format("2006-01-02 15:04:05")
		startedRel = relativeTime(t)
		startedDay = dayBucket(t)
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
		Cost:            costLabel(cost, priced),
		costAmount:      cost,
		costPriced:      priced,
		Device:          device,
		StartedAt:       startedRel,
		StartedAtFull:   startedFull,
		StartedRel:      startedRel,
		StartedDay:      startedDay,
		OpenURL:         openURL,
		Kinds:           append([]string(nil), s.Kinds...),
	}
}

// dayBucket labels a start time as the feed's day header: "Today",
// "Yesterday", or a dated weekday (the year is shown only when it differs
// from the current one). Buckets are computed in local time against nowFn so
// the grouping matches the relative timestamps in each row.
func dayBucket(t time.Time) string {
	now := nowFn().In(time.Local)
	y, m, d := now.Date()
	today := time.Date(y, m, d, 0, 0, 0, 0, time.Local)
	ty, tm, td := t.In(time.Local).Date()
	day := time.Date(ty, tm, td, 0, 0, 0, 0, time.Local)
	switch days := int(today.Sub(day).Hours()) / 24; {
	case days == 0:
		return "Today"
	case days == 1:
		return "Yesterday"
	case ty == y:
		return t.In(time.Local).Format("Mon, Jan 2")
	default:
		return t.In(time.Local).Format("Mon, Jan 2, 2006")
	}
}

func rollUpSessionRowCost(row *sessionRow) {
	if row == nil {
		return
	}
	cost := row.costAmount
	priced := row.costPriced
	for _, child := range row.Children {
		if child.costPriced {
			cost += child.costAmount
			priced = true
		}
	}
	row.costAmount = cost
	row.costPriced = priced
	row.Cost = costLabel(cost, priced)
}

func sessionCost(s *prosav1.Session) (float64, bool) {
	if s == nil {
		return 0, false
	}
	return pricing.CostUSD(s.Model, tokenUsageFromProto(s.Usage))
}

func addSessionCost(total float64, priced bool, s *prosav1.Session) (float64, bool) {
	cost, ok := sessionCost(s)
	if ok {
		return total + cost, true
	}
	return total, priced
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
		Profile:       in.Profile,
		Query:         in.Query,
		SortBy:        in.SortBy,
		SortDir:       in.SortDir,
		Limit:         in.Limit,
		Offset:        in.Offset,
		TopLevelOnly:  in.TopLevelOnly,
	}
	if len(in.DeviceNames) > 0 {
		out.DeviceNames = append([]string(nil), in.DeviceNames...)
	}
	if len(in.Agents) > 0 {
		out.Agents = append([]string(nil), in.Agents...)
	}
	if len(in.ProjectMatches) > 0 {
		out.ProjectMatches = append([]string(nil), in.ProjectMatches...)
	}
	if len(in.Profiles) > 0 {
		out.Profiles = append([]string(nil), in.Profiles...)
	}
	if len(in.Kinds) > 0 {
		out.Kinds = append([]string(nil), in.Kinds...)
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

// listProfileLabels resolves the profile dropdown choices from the analytics
// "profiles" report (profile name is the third column). Non-fatal on failure.
func (p *Panel) listProfileLabels(ctx context.Context, since, until time.Time) ([]string, error) {
	resp, err := p.clients.Analytics.GetReport(ctx, connect.NewRequest(&prosav1.GetReportRequest{
		Report: "profiles",
		Since:  timestamppb.New(since),
		Until:  timestamppb.New(until),
	}))
	if err != nil {
		return nil, err
	}
	return profileLabelsFromRows(resp.Msg.Rows), nil
}
