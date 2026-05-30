package panel

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
)

// handleHome renders the cross-device timeline. Filters come from
// query string; everything is server-rendered HTML so HTMX can swap
// fragments later if needed.
func (p *Panel) handleHome(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	window, err := parseWindow(q.Get("last"))
	if err != nil {
		http.Error(w, "bad last= "+err.Error(), http.StatusBadRequest)
		return
	}
	now := time.Now().UTC()
	req := &prosav1.ListRequest{
		Since: timestamppb.New(now.Add(-window)),
		Until: timestamppb.New(now),
		Limit: 200,
	}
	if v := q.Get("project"); v != "" {
		req.ProjectMatch = v
	}
	if v := q.Get("agent"); v != "" {
		req.Agent = v
	}
	if v := q.Get("device"); v != "" {
		req.DeviceName = v
	}
	resp, err := p.clients.Sessions.List(r.Context(), connect.NewRequest(req))
	if err != nil {
		slog.Error("home sessions.list failed", "err", err)
		http.Error(w, "list failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	groups := groupByDay(resp.Msg.Sessions, time.Local)

	data := map[string]any{
		"Title":     "Home",
		"Nav":       "home",
		"Last":      q.Get("last"),
		"Project":   q.Get("project"),
		"Agent":     q.Get("agent"),
		"Device":    q.Get("device"),
		"Sessions":  resp.Msg.Sessions,
		"DayGroups": groups,
	}
	// Render side panel inline when ?session=<id>.
	if sid := q.Get("session"); sid != "" {
		sp, err := p.loadSidePanel(r.Context(), sid)
		if err != nil {
			slog.Warn("side panel load failed", "id", sid, "err", err)
		} else {
			data["SidePanel"] = sp
		}
	}
	p.render(w, "home", data)
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
	p.render(w, "raw_chunk", map[string]any{
		"ID":       sid,
		"Chunk":    string(resp.Msg.Chunk),
		"NextURL":  fmt.Sprintf("/raw/%s?offset=%d", sid, offset+int64(len(resp.Msg.Chunk))),
		"EOF":      resp.Msg.Eof,
		"Total":    resp.Msg.TotalSize,
		"Progress": offset + int64(len(resp.Msg.Chunk)),
	})
}

// sidePanelData bundles the metadata + first raw chunk the side panel
// renders inline.
type sidePanelData struct {
	Session  *prosav1.Session
	Turns    []*prosav1.Turn
	Tools    []*prosav1.ToolUsage
	Chunk    string
	NextURL  string
	EOF      bool
	Total    int64
	Progress int64
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
	sp := sidePanelData{
		Session:  getResp.Msg.Session,
		Turns:    getResp.Msg.Turns,
		Tools:    getResp.Msg.Tools,
		Chunk:    string(rawResp.Msg.Chunk),
		EOF:      rawResp.Msg.Eof,
		Total:    rawResp.Msg.TotalSize,
		Progress: int64(len(rawResp.Msg.Chunk)),
	}
	if !sp.EOF {
		sp.NextURL = fmt.Sprintf("/raw/%s?offset=%d", id, sp.Progress)
	}
	return sp, nil
}

// dayGroup is one row block in the timeline.
type dayGroup struct {
	Label    string
	Sessions []*prosav1.Session
}

func groupByDay(in []*prosav1.Session, loc *time.Location) []dayGroup {
	buckets := map[string][]*prosav1.Session{}
	keys := []string{}
	for _, s := range in {
		k := s.StartedAt.AsTime().In(loc).Format("2006-01-02")
		if _, ok := buckets[k]; !ok {
			keys = append(keys, k)
		}
		buckets[k] = append(buckets[k], s)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(keys)))
	now := time.Now().In(loc)
	out := make([]dayGroup, 0, len(keys))
	for _, k := range keys {
		t, _ := time.ParseInLocation("2006-01-02", k, loc)
		out = append(out, dayGroup{Label: humanDay(t, now), Sessions: buckets[k]})
	}
	return out
}

func humanDay(t, now time.Time) string {
	d := now.Sub(t)
	switch {
	case d < 24*time.Hour && t.Day() == now.Day():
		return "Today"
	case d < 48*time.Hour && t.Day() == now.AddDate(0, 0, -1).Day():
		return "Yesterday"
	case d < 7*24*time.Hour:
		return t.Format("Mon, Jan 2")
	}
	return t.Format("Mon, Jan 2 2006")
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
		"Title":          "Devices",
		"Nav":            "devices",
		"Devices":        resp.Msg.Devices,
		"Notice":         r.URL.Query().Get("notice"),
		"ApproveError":   r.URL.Query().Get("approve_error"),
		"ApproveSuccess": r.URL.Query().Get("approve_ok"),
	})
}

// handleDevicesAction dispatches POST /devices/<id>/rename | revoke
// and POST /devices/approve.
func (p *Panel) handleDevicesAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/devices/")
	if rest == "approve" {
		p.handleDeviceApprove(w, r)
		return
	}
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

// handleDeviceApprove takes the user_code from the form and forwards
// it to AuthService.ApproveLogin with the panel's admin token.
func (p *Panel) handleDeviceApprove(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	code := strings.TrimSpace(r.FormValue("user_code"))
	if code == "" {
		http.Redirect(w, r, "/devices?approve_error=user_code+missing", http.StatusSeeOther)
		return
	}
	resp, err := p.clients.Auth.ApproveLogin(r.Context(),
		connect.NewRequest(&prosav1.ApproveLoginRequest{
			UserCode:   code,
			AdminToken: p.cfg.AdminToken,
		}))
	if err != nil {
		slog.Warn("approve login failed", "code", code, "err", err)
		http.Redirect(w, r, "/devices?approve_error="+queryEscape(err.Error()), http.StatusSeeOther)
		return
	}
	slog.Info("device approved", "code", code, "device", resp.Msg.DeviceId)
	http.Redirect(w, r, "/devices?approve_ok="+queryEscape(resp.Msg.DeviceId), http.StatusSeeOther)
}

// handleSSE proxies the server's /sse/events stream to the browser.
// The panel adds the Admin header so the server lets it in; the
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

	resp, err := http.DefaultClient.Do(req)
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

// handleAnalytics renders one of the five reports. Report name comes
// from the URL path; remaining filters mirror the home view.
func (p *Panel) handleAnalytics(w http.ResponseWriter, r *http.Request) {
	report := strings.TrimPrefix(r.URL.Path, "/analytics/")
	if report == "" {
		report = "sessions"
	}
	window, err := parseWindow(r.URL.Query().Get("last"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	now := time.Now().UTC()
	resp, err := p.clients.Analytics.GetReport(r.Context(),
		connect.NewRequest(analyticsRequest(report, now.Add(-window), now, r.URL.Query())))
	if err != nil {
		slog.Error("analytics rpc failed", "report", report, "err", err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	data := map[string]any{
		"Title":   "Analytics — " + report,
		"Nav":     "analytics-" + report,
		"Report":  report,
		"Last":    r.URL.Query().Get("last"),
		"Project": r.URL.Query().Get("project"),
		"Agent":   r.URL.Query().Get("agent"),
		"Device":  r.URL.Query().Get("device"),
		"Agents":  []string{"codex", "claude-code", "gemini", "hermes", "cursor"},
		"Windows": analyticsWindowLinks(r.URL.Query()),
		"Headers": resp.Msg.Headers,
		"Rows":    resp.Msg.Rows,
	}
	if report == "heatmap" {
		cells, total, max := buildHeatmap(resp.Msg.Rows)
		data["HeatmapCells"] = cells
		data["HeatmapTotal"] = total
		data["HeatmapMax"] = max
	}
	if report == "usage" {
		rows, totalTokens, totalCost := buildUsage(resp.Msg.Rows)
		data["UsageRows"] = rows
		data["UsageTotalTokens"] = formatPanelInt(totalTokens)
		data["UsageTotalCost"] = totalCost
	}
	p.render(w, "analytics", data)
}

func analyticsRequest(report string, since, until time.Time, q map[string][]string) *prosav1.GetReportRequest {
	req := &prosav1.GetReportRequest{
		Report: report,
		Since:  timestamppb.New(since),
		Until:  timestamppb.New(until),
	}
	get := func(key string) string {
		if vals := q[key]; len(vals) > 0 {
			return vals[0]
		}
		return ""
	}
	req.ProjectMatch = get("project")
	req.Agent = get("agent")
	req.DeviceName = get("device")
	return req
}

func analyticsWindowLinks(q map[string][]string) map[string]string {
	out := map[string]string{}
	for _, last := range []string{"12h", "7d", "30d", "365d"} {
		next := make(map[string][]string, len(q)+1)
		for k, vals := range q {
			cp := append([]string(nil), vals...)
			next[k] = cp
		}
		next["last"] = []string{last}
		out[last] = "?" + urlValues(next)
	}
	return out
}

func urlValues(q map[string][]string) string {
	vals := make([]string, 0, len(q))
	for k, vs := range q {
		for _, v := range vs {
			vals = append(vals, queryEscape(k)+"="+queryEscape(v))
		}
	}
	sort.Strings(vals)
	return strings.Join(vals, "&")
}

type heatmapCell struct {
	Date  string
	Count int64
	Level int
	Blank bool
}

func buildHeatmap(rows []*prosav1.AnalyticsRow) ([]heatmapCell, int64, int64) {
	var (
		cells []heatmapCell
		max   int64
		total int64
	)
	counts := make([]int64, 0, len(rows))
	for _, row := range rows {
		if len(row.Values) < 2 {
			counts = append(counts, 0)
			continue
		}
		n, _ := strconv.ParseInt(row.Values[1], 10, 64)
		counts = append(counts, n)
		if n > max {
			max = n
		}
		total += n
	}
	if len(rows) > 0 && len(rows[0].Values) > 0 {
		if t, err := time.Parse("2006-01-02", rows[0].Values[0]); err == nil {
			for i := 0; i < int(t.Weekday()); i++ {
				cells = append(cells, heatmapCell{Blank: true})
			}
		}
	}
	for i, row := range rows {
		date := ""
		if len(row.Values) > 0 {
			date = row.Values[0]
		}
		count := counts[i]
		level := 0
		if max > 0 && count > 0 {
			level = int((count*4 + max - 1) / max)
			if level > 4 {
				level = 4
			}
		}
		cells = append(cells, heatmapCell{Date: date, Count: count, Level: level})
	}
	return cells, total, max
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
	}
	parsed := make([]parsedRow, 0, len(rows))
	var maxTotal, totalTokens int64
	var totalCost float64
	priced := false
	for _, row := range rows {
		if len(row.Values) < 8 {
			continue
		}
		total := parsePanelInt(row.Values[3])
		if total > maxTotal {
			maxTotal = total
		}
		totalTokens += total
		cost := strings.TrimSpace(row.Values[7])
		costLabel := "n/a"
		if cost != "" {
			if f, err := strconv.ParseFloat(cost, 64); err == nil {
				totalCost += f
				priced = true
			}
			costLabel = "$" + cost
		}
		parsed = append(parsed, parsedRow{
			total: total,
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
	for _, row := range parsed {
		percent := 0
		if maxTotal > 0 && row.total > 0 {
			percent = int((row.total*100 + maxTotal - 1) / maxTotal)
			if percent < 3 {
				percent = 3
			}
		}
		row.values.Percent = percent
		out = append(out, row.values)
	}
	if !priced {
		return out, totalTokens, "n/a"
	}
	return out, totalTokens, fmt.Sprintf("$%.4f", totalCost)
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
