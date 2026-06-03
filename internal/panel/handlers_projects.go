package panel

import (
	"log/slog"
	"net/http"
	"time"

	"connectrpc.com/connect"
)

// handleProjects renders the projects landing page: same data as the
// old /analytics/projects report, but each row links into a filtered
// /sessions view. The window comes from ?last= (default 30d).
func (p *Panel) handleProjects(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	last := q.Get("last")
	// Default to 30d when the caller didn't specify; analytics' default
	// is 7d but projects-as-landing wants a roomier window so labels
	// from earlier in the month still show up.
	if last == "" {
		last = "30d"
	}
	window, err := parseWindow(last)
	if err != nil {
		http.Error(w, "bad last= "+err.Error(), http.StatusBadRequest)
		return
	}
	now := time.Now().UTC()
	since, until := now.Add(-window), now
	resp, err := p.clients.Analytics.GetReport(r.Context(),
		connect.NewRequest(analyticsRequest("projects", since, until, q)))
	if err != nil {
		slog.Error("projects report failed", "err", err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	p.render(w, "projects", map[string]any{
		"Title":   "Projects",
		"Nav":     "projects",
		"Last":    q.Get("last"),
		"Headers": resp.Msg.Headers,
		"Rows":    resp.Msg.Rows,
	})
}
