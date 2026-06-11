package panel

import (
	"log/slog"
	"net/http"
	"time"

	"connectrpc.com/connect"
)

// handleProfiles renders the device × agent × profile breakdown, each cell
// linking into a filtered /sessions view. Window from ?last= (default 30d).
func (p *Panel) handleProfiles(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	last := q.Get("last")
	if last == "" {
		last = "30d"
	}
	now := nowFn().UTC()
	until := now
	var since time.Time
	if last == "all" {
		since = now.Add(-100 * 365 * 24 * time.Hour)
	} else {
		window, err := parseWindow(last)
		if err != nil {
			http.Error(w, "bad last= "+err.Error(), http.StatusBadRequest)
			return
		}
		since = now.Add(-window)
	}
	resp, err := p.clients.Analytics.GetReport(r.Context(),
		connect.NewRequest(analyticsRequest("profiles", since, until, q)))
	if err != nil {
		slog.Error("profiles report failed", "err", err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	p.render(w, "profiles", map[string]any{
		"Title":   "Profiles",
		"Nav":     "profiles",
		"CSRF":    p.csrfFromRequest(r),
		"Last":    last,
		"Headers": resp.Msg.Headers,
		"Rows":    resp.Msg.Rows,
	})
}
