package panel

import (
	"log/slog"
	"net/http"
	"strings"

	"connectrpc.com/connect"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
)

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
	p.render(w, r, "devices", map[string]any{
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
