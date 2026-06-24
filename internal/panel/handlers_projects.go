package panel

import (
	"log/slog"
	"net/http"
	"strings"

	"connectrpc.com/connect"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
)

// projectBoardRow is one row of the Projects leaderboard: the raw project
// label (the template resolves its display + links), the agent, the
// formatted session count, and the count as a percentage of the busiest
// project so the row can draw a magnitude bar.
type projectBoardRow struct {
	Project  string
	Agent    string
	Sessions string
	Percent  int
}

// buildProjectBoard shapes the projects report rows into leaderboard rows,
// scaling each bar against the busiest project. Column positions come from
// the report headers so the panel doesn't hardcode the report's shape.
func buildProjectBoard(headers []string, rows []*prosav1.AnalyticsRow) []projectBoardRow {
	idx := func(name string) int {
		for i, h := range headers {
			if strings.EqualFold(h, name) {
				return i
			}
		}
		return -1
	}
	pIdx, aIdx, sIdx := idx("project"), idx("agent"), idx("sessions")
	var maxSessions int64
	if sIdx >= 0 {
		for _, row := range rows {
			if sIdx < len(row.Values) {
				if n := parsePanelInt(row.Values[sIdx]); n > maxSessions {
					maxSessions = n
				}
			}
		}
	}
	board := make([]projectBoardRow, 0, len(rows))
	for _, row := range rows {
		get := func(i int) string {
			if i >= 0 && i < len(row.Values) {
				return row.Values[i]
			}
			return ""
		}
		n := parsePanelInt(get(sIdx))
		pct := 0
		if maxSessions > 0 {
			pct = int(n * 100 / maxSessions)
		}
		board = append(board, projectBoardRow{
			Project:  get(pIdx),
			Agent:    get(aIdx),
			Sessions: formatPanelInt(n),
			Percent:  pct,
		})
	}
	return board
}

// handleProjects renders the projects landing page: same data as the
// old /analytics/projects report, but each row links into a filtered
// /sessions view. The window comes from ?last= or the owner's page preference.
func (p *Panel) handleProjects(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	last, defaultLast := p.resolvePageWindow(r, windowPageProjects)
	now := nowFn().UTC()
	since, until, err := parseDashboardWindow(last, now)
	if err != nil {
		http.Error(w, "bad last= "+err.Error(), http.StatusBadRequest)
		return
	}
	resp, err := p.clients.Analytics.GetReport(r.Context(),
		connect.NewRequest(analyticsRequest("projects", since, until, q)))
	if err != nil {
		slog.Error("projects report failed", "err", err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	p.render(w, r, "projects", map[string]any{
		"Title":         "Projects",
		"Nav":           "projects",
		"CSRF":          p.csrfFromRequest(r),
		"Last":          last,
		"DefaultWindow": defaultLast,
		"Rows":          buildProjectBoard(resp.Msg.Headers, resp.Msg.Rows),
	})
}
