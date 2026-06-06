package panel

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"
	"golang.org/x/sync/errgroup"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/panel/render"
	"github.com/c3-oss/prosa/internal/pricing"
	"github.com/c3-oss/prosa/internal/sessiontext"
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

// pickDeviceNames pulls every "device" entry from the query string,
// dropping empties. Both ?device=A&device=B and the legacy single
// ?device=A reach the same multi-value slice here, so callers can
// always set ListRequest.DeviceNames.
func pickDeviceNames(q url.Values) []string {
	vals := q["device"]
	out := make([]string, 0, len(vals))
	for _, v := range vals {
		v = strings.TrimSpace(v)
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}

// handleSessionDetail handles HTMX swap requests like
// GET /sessions/<id> → partial fragment that fills #side-panel.
func (p *Panel) handleSessionDetail(w http.ResponseWriter, r *http.Request) {
	sid := strings.TrimPrefix(r.URL.Path, "/sessions/")
	if sid == "" {
		http.NotFound(w, r)
		return
	}
	sp, err := p.loadSidePanel(r.Context(), sid)
	if err != nil {
		slog.Warn("side panel load failed", "id", sid, "err", err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	p.render(w, "side_panel", map[string]any{
		"SidePanel": sp,
	})
}

// handleRawChunk paginates the raw transcript. URL:
// /raw/<id>?offset=N. Returns an HTML fragment that HTMX appends.
func (p *Panel) handleRawChunk(w http.ResponseWriter, r *http.Request) {
	sid := strings.TrimPrefix(r.URL.Path, "/raw/")
	if sid == "" {
		http.NotFound(w, r)
		return
	}
	offset, _ := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
	resp, err := p.clients.Sessions.GetRaw(r.Context(), connect.NewRequest(&prosav1.GetRawRequest{
		Id:     sid,
		Offset: offset,
		Limit:  65536,
	}))
	if err != nil {
		slog.Warn("raw chunk failed", "id", sid, "err", err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	chunk := resp.Msg.Chunk
	progress := offset + int64(len(chunk))
	chunkText := string(chunk)
	eof := resp.Msg.Eof
	nextURL := fmt.Sprintf("/raw/%s?offset=%d", sid, progress)
	if isBinaryChunk(chunk) {
		chunkText = binaryPlaceholder(resp.Msg.TotalSize)
		eof = true
		nextURL = ""
	}
	p.render(w, "raw_chunk", map[string]any{
		"ID":       sid,
		"Chunk":    chunkText,
		"NextURL":  nextURL,
		"EOF":      eof,
		"Total":    resp.Msg.TotalSize,
		"Progress": progress,
	})
}

// sidePanelData bundles the metadata + first raw chunk the side panel
// renders inline. TurnsCount/ToolsCount/DurationLabel feed the stats
// cluster at the top of the panel; TurnGroups is what the transcript
// section iterates over. Children is the (possibly empty) list of
// subagent sessions spawned from this one; the template renders a
// dedicated "Subagents" disclosure when it's non-empty. All derived in
// loadSidePanel so the template stays declarative.
type sidePanelData struct {
	Session       *prosav1.Session
	Project       projectDisplay
	TokensTotal   string
	TokensIn      string
	TokensOut     string
	Cost          string
	Turns         []render.Turn
	TurnGroups    []render.TurnGroup
	Tools         []*prosav1.ToolUsage
	Children      []*prosav1.Session
	TurnsCount    int
	ToolsCount    int
	DurationLabel string
	Chunk         string
	NextURL       string
	EOF           bool
	Total         int64
	Progress      int64
}

func (p *Panel) loadSidePanel(ctx context.Context, id string) (sidePanelData, error) {
	getResp, err := p.clients.Sessions.Get(ctx, connect.NewRequest(&prosav1.GetRequest{Id: id}))
	if err != nil {
		return sidePanelData{}, err
	}
	rawResp, err := p.clients.Sessions.GetRaw(ctx, connect.NewRequest(&prosav1.GetRawRequest{
		Id:     id,
		Offset: 0,
		Limit:  65536,
	}))
	if err != nil {
		return sidePanelData{}, err
	}
	chunk := rawResp.Msg.Chunk
	chunkText := string(chunk)
	eof := rawResp.Msg.Eof
	if isBinaryChunk(chunk) {
		chunkText = binaryPlaceholder(rawResp.Msg.TotalSize)
		eof = true
	}
	turns := buildDisplayTurns(getResp.Msg.Turns)
	// Children are looked up best-effort: a failure here shouldn't
	// block the sidepanel from rendering. Log + treat as empty.
	var children []*prosav1.Session
	childResp, childErr := p.clients.Sessions.ListChildren(ctx,
		connect.NewRequest(&prosav1.ListChildrenRequest{ParentId: id}))
	if childErr != nil {
		slog.Warn("side panel list children failed", "id", id, "err", childErr)
	} else {
		children = childResp.Msg.Sessions
	}
	sess := getResp.Msg.Session
	usage := tokenUsageFromProto(sess.GetUsage())
	costLabel := "n/a"
	if cost, ok := pricing.CostUSD(sess.GetModel(), usage); ok {
		costLabel = fmt.Sprintf("$%.2f", cost)
	}
	sp := sidePanelData{
		Session:       sess,
		Project:       projectDisplayFromSession(sess),
		TokensTotal:   formatPanelInt(usage.TotalTokens),
		TokensIn:      formatPanelInt(usage.InputTokens),
		TokensOut:     formatPanelInt(usage.OutputTokens),
		Cost:          costLabel,
		Turns:         turns,
		TurnGroups:    render.GroupTurns(turns),
		Tools:         getResp.Msg.Tools,
		Children:      children,
		TurnsCount:    countMessageDisplayTurns(turns),
		ToolsCount:    sumToolCounts(getResp.Msg.Tools),
		DurationLabel: sessionDurationLabel(sess),
		Chunk:         chunkText,
		EOF:           eof,
		Total:         rawResp.Msg.TotalSize,
		Progress:      int64(len(chunk)),
	}
	if !sp.EOF {
		sp.NextURL = fmt.Sprintf("/raw/%s?offset=%d", id, sp.Progress)
	}
	return sp, nil
}

// countMessageDisplayTurns counts user + assistant message turns,
// skipping tool_result and operational rows. The stats cluster's
// "turns" KPI is meant to convey "how many exchanges did I have", not
// "how many DB rows projected".
func countMessageDisplayTurns(in []render.Turn) int {
	n := 0
	for _, t := range in {
		if t.Kind == "tool_result" || t.Kind == "operational" {
			continue
		}
		n++
	}
	return n
}

// sumToolCounts adds up every per-tool invocation count. The list is
// already aggregated server-side; this just collapses it to one number.
func sumToolCounts(in []*prosav1.ToolUsage) int {
	n := 0
	for _, u := range in {
		if u == nil {
			continue
		}
		n += int(u.Count)
	}
	return n
}

// sessionDurationLabel renders the session length as humanDuration
// expects it: "—" when either timestamp is missing, otherwise the
// formatted gap.
func sessionDurationLabel(s *prosav1.Session) string {
	if s == nil || s.StartedAt == nil || s.LastActivityAt == nil {
		return "—"
	}
	return humanDuration(s.LastActivityAt.AsTime().Sub(s.StartedAt.AsTime()))
}

// buildDisplayTurns converts the connect Turn slice into the panel's
// render-ready render.Turn slice. Assistant content is rendered as
// markdown; user and tool content is escaped plain text with newlines
// preserved. ANSI escapes and control characters are stripped first
// so terminal-leaked output stays readable.
//
// Returning fresh render.Turn structs means we never share the
// connect response's protobuf pointers — concurrent requests don't
// race on Content and the proto's embedded sync state stays untouched.
func buildDisplayTurns(in []*prosav1.Turn) []render.Turn {
	if len(in) == 0 {
		return nil
	}
	out := make([]render.Turn, 0, len(in))
	for _, t := range in {
		if t == nil {
			continue
		}
		ts := time.Time{}
		if t.Ts != nil {
			ts = t.Ts.AsTime()
		}
		dt := render.Turn{
			Role:     t.Role,
			Kind:     t.Kind,
			ToolName: t.ToolName,
			Ts:       ts,
		}
		switch t.Role {
		case "assistant":
			dt.Body = render.Markdown(sessiontext.SanitizeForDisplay(t.Content))
		case "user":
			// Boilerplate (system-reminders, slash command wrappers,
			// env_context, …) gets peeled off so the bubble body shows
			// just the human-authored prompt; the wrappers attach as
			// UserExtras for the template to surface as chips/details.
			parsed := sessiontext.ParseUserMessage(t.Content)
			dt.Body = render.PlainText(parsed.Body)
			dt.UserExtras = userExtrasFromParsed(parsed)
		default:
			dt.Body = render.PlainText(sessiontext.SanitizeForDisplay(t.Content))
		}
		out = append(out, dt)
	}
	return out
}

// userExtrasFromParsed lifts the wrapper-derived fields out of a
// sessiontext.UserMessage into render.UserExtras. Returns nil when
// the message had no boilerplate — the template uses that to skip
// the chip/details rendering entirely.
func userExtrasFromParsed(p sessiontext.UserMessage) *render.UserExtras {
	if !p.HasExtras() {
		return nil
	}
	return &render.UserExtras{
		Command:                 p.Command,
		CommandArgs:             p.CommandArgs,
		CommandMessage:          p.CommandMessage,
		Reminders:               p.Reminders,
		EnvContext:              p.EnvContext,
		Instructions:            p.Instructions,
		CollaborationMode:       p.CollaborationMode,
		PermissionsInstructions: p.PermissionsInstructions,
		LocalCommandCaveat:      p.LocalCommandCaveat,
		LocalCommandStdout:      p.LocalCommandStdout,
		LocalCommandStderr:      p.LocalCommandStderr,
	}
}

// isBinaryChunk reports whether b looks like binary content unfit for a
// <pre>. True when b starts with the SQLite magic header, contains a
// NUL byte in the first sniffN bytes, or has invalid UTF-8 in the same
// head. Empty input returns false — nothing to display, nothing to flag.
func isBinaryChunk(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	const sqliteMagic = "SQLite format 3\x00"
	if bytes.HasPrefix(b, []byte(sqliteMagic)) {
		return true
	}
	const sniffN = 4096
	head := b
	if len(head) > sniffN {
		head = head[:sniffN]
	}
	if bytes.IndexByte(head, 0x00) >= 0 {
		return true
	}
	if !validUTF8Sniff(head) {
		return true
	}
	return false
}

func validUTF8Sniff(head []byte) bool {
	for len(head) > 0 {
		r, size := utf8.DecodeRune(head)
		if r == utf8.RuneError && size == 1 {
			need := utf8SequenceLen(head[0])
			if need == 0 || need <= len(head) {
				return false
			}
			// The sniff window can end in the middle of a valid text rune.
			// Treat that as text; the next raw chunk/page owns the remainder.
			return true
		}
		head = head[size:]
	}
	return true
}

func utf8SequenceLen(b byte) int {
	switch {
	case b < utf8.RuneSelf:
		return 1
	case b >= 0xC2 && b <= 0xDF:
		return 2
	case b >= 0xE0 && b <= 0xEF:
		return 3
	case b >= 0xF0 && b <= 0xF4:
		return 4
	default:
		return 0
	}
}

// binaryPlaceholder is the human-readable message shown in the side
// panel in place of binary raw transcripts (e.g. Cursor store.db files
// that the importer preserves verbatim for re-import audit).
func binaryPlaceholder(total int64) string {
	return fmt.Sprintf("Binary content (%d bytes, preserved verbatim) — not displayable as text.", total)
}

// humanDuration is a panel-side wrapper around render.HumanDuration —
// kept for backwards-compat with sessionDurationLabel. The canonical
// implementation lives in internal/panel/render so the transcript
// divider can share the format with the stats cluster.
func humanDuration(d time.Duration) string {
	return render.HumanDuration(d)
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

// parseWindow turns "12h" / "7d" / "30d" (CLI vernacular) into a
// duration. Default 7d.
func parseWindow(s string) (time.Duration, error) {
	if s == "" {
		return 7 * 24 * time.Hour, nil
	}
	if strings.HasSuffix(s, "h") {
		n, err := strconv.Atoi(strings.TrimSuffix(s, "h"))
		if err != nil {
			return 0, err
		}
		return time.Duration(n) * time.Hour, nil
	}
	if strings.HasSuffix(s, "d") {
		n, err := strconv.Atoi(strings.TrimSuffix(s, "d"))
		if err != nil {
			return 0, err
		}
		return time.Duration(n) * 24 * time.Hour, nil
	}
	return 0, fmt.Errorf("unrecognized window %q (try 12h, 7d, 30d)", s)
}

// handleDevices renders the device admin table. Owner caller; the
// server returns every device row regardless of who's asking.
func (p *Panel) handleDevices(w http.ResponseWriter, r *http.Request) {
	resp, err := p.clients.Devices.List(r.Context(),
		connect.NewRequest(&prosav1.DevicesServiceListRequest{}))
	if err != nil {
		slog.Error("devices.list failed", "err", err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	p.render(w, "devices", map[string]any{
		"Title":   "Devices",
		"Nav":     "devices",
		"Devices": resp.Msg.Devices,
		"Notice":  r.URL.Query().Get("notice"),
		"CSRF":    p.csrfFromRequest(r),
	})
}

// handleDevicesAction dispatches POST /devices/<id>/rename | revoke.
func (p *Panel) handleDevicesAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/devices/")
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) != 2 {
		http.NotFound(w, r)
		return
	}
	id, action := parts[0], parts[1]
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	switch action {
	case "rename":
		name := strings.TrimSpace(r.FormValue("friendly_name"))
		if name == "" {
			http.Error(w, "friendly_name required", http.StatusBadRequest)
			return
		}
		if _, err := p.clients.Devices.Rename(r.Context(),
			connect.NewRequest(&prosav1.RenameRequest{Id: id, FriendlyName: name})); err != nil {
			slog.Error("rename rpc failed", "id", id, "err", err)
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
	case "revoke":
		if _, err := p.clients.Devices.Revoke(r.Context(),
			connect.NewRequest(&prosav1.RevokeRequest{Id: id})); err != nil {
			slog.Error("revoke rpc failed", "id", id, "err", err)
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
	default:
		http.NotFound(w, r)
		return
	}
	http.Redirect(w, r, "/devices?notice=updated", http.StatusSeeOther)
}

// handleSSE proxies the server's /sse/events stream to the browser.
// The panel adds the Admin header so the server lets it in; the
// sseProxyClient proxies the upstream /sse/events stream. ResponseHeaderTimeout
// bounds only the wait for the upstream's response headers, so a stuck
// upstream can't hang the proxy goroutine at dial time; the body stream
// itself stays unbounded (no client Timeout) so long-lived SSE isn't cut.
// Cloned from DefaultTransport to keep its connection-pool defaults.
var sseProxyClient = &http.Client{
	Transport: func() http.RoundTripper {
		t := http.DefaultTransport.(*http.Transport).Clone()
		t.ResponseHeaderTimeout = 10 * time.Second
		return t
	}(),
}

// browser only ever sees a normal SSE stream from the same origin
// (no CORS / cross-site cookie issues).
func (p *Panel) handleSSE(w http.ResponseWriter, r *http.Request) {
	upstream := strings.TrimRight(p.cfg.ServerURL, "/") + "/sse/events"
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, upstream, nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header.Set("Authorization", "Admin "+p.cfg.AdminToken)
	req.Header.Set("Accept", "text/event-stream")

	resp, err := sseProxyClient.Do(req)
	if err != nil {
		slog.Warn("sse upstream dial failed", "err", err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		http.Error(w, "upstream sse error: "+resp.Status, http.StatusBadGateway)
		return
	}

	// Close the upstream body as soon as the browser disconnects so the
	// read loop below unblocks promptly instead of waiting for the upstream
	// to send data or EOF. The watcher always returns: when this handler
	// finishes, net/http cancels r.Context(). Closing twice (here + defer)
	// is harmless.
	go func() {
		<-r.Context().Done()
		_ = resp.Body.Close()
	}()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)

	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}

func analyticsRequest(report string, since, until time.Time, q url.Values) *prosav1.GetReportRequest {
	req := &prosav1.GetReportRequest{
		Report:      report,
		Since:       timestamppb.New(since),
		Until:       timestamppb.New(until),
		DeviceNames: pickDeviceNames(q),
	}
	req.ProjectMatch = q.Get("project")
	req.Agent = q.Get("agent")
	return req
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

func parsePanelInt(s string) int64 {
	n, _ := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	return n
}

func formatPanelInt(n int64) string {
	sign := ""
	if n < 0 {
		sign = "-"
		n = -n
	}
	s := strconv.FormatInt(n, 10)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return sign + s
}

// formatTokensCompact abbreviates large token counts for the Sessions table
// (e.g. 1.2k, 3.4m). Values under 1000 stay exact. One decimal is shown
// unless it is .0; rounding rolls up to the next unit at 1000 (999990 → 1m).
func formatTokensCompact(n int64) string {
	sign := ""
	if n < 0 {
		sign = "-"
		n = -n
	}
	if n < 1000 {
		return sign + strconv.FormatInt(n, 10)
	}
	type unit struct {
		div float64
		suf string
	}
	units := []unit{{1e3, "k"}, {1e6, "m"}, {1e9, "b"}}
	idx := 0
	if n >= 1_000_000_000 {
		idx = 2
	} else if n >= 1_000_000 {
		idx = 1
	}
	for idx < len(units) {
		value := float64(n) / units[idx].div
		rounded := math.Round(value*10) / 10
		if rounded < 1000 || idx == len(units)-1 {
			return sign + formatCompactDecimal(rounded) + units[idx].suf
		}
		idx++
	}
	value := float64(n) / units[len(units)-1].div
	rounded := math.Round(value*10) / 10
	return sign + formatCompactDecimal(rounded) + units[len(units)-1].suf
}

func formatCompactDecimal(v float64) string {
	s := strconv.FormatFloat(v, 'f', 1, 64)
	if strings.HasSuffix(s, ".0") {
		return strings.TrimSuffix(s, ".0")
	}
	return s
}
