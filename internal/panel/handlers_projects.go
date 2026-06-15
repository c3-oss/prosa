package panel

import (
	"log/slog"
	"net/http"

	"connectrpc.com/connect"
)

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
		"Headers":       resp.Msg.Headers,
		"Rows":          resp.Msg.Rows,
	})
}
