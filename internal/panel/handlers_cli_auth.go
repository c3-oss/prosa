package panel

import (
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"connectrpc.com/connect"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
)

func (p *Panel) handleCliAuthorize(w http.ResponseWriter, r *http.Request) {
	requestID := strings.TrimSpace(r.URL.Query().Get("request_id"))
	if requestID == "" {
		p.renderCliAuthorizeError(w, "missing request_id")
		return
	}
	if errMsg := r.URL.Query().Get("approve_error"); errMsg != "" {
		p.renderCliAuthorizeError(w, errMsg)
		return
	}
	resp, err := p.clients.Auth.GetLoginRequest(r.Context(),
		connect.NewRequest(&prosav1.GetLoginRequestRequest{RequestId: requestID}))
	if err != nil {
		slog.Warn("get login request failed", "request_id", requestID, "err", err)
		p.renderCliAuthorizeError(w, "login request not found or expired")
		return
	}
	msg := resp.Msg
	if msg.State != "PENDING" {
		p.renderCliAuthorizeError(w, fmt.Sprintf("login request is %s", msg.State))
		return
	}
	expires := "—"
	if msg.ExpiresAt != nil {
		expires = msg.ExpiresAt.AsTime().Local().Format("2006-01-02 15:04 MST")
	}
	fp := msg.Fingerprint
	if len(fp) > 16 {
		fp = fp[:8] + "…" + fp[len(fp)-8:]
	}
	p.render(w, "cli_authorize", map[string]any{
		"RequestID":   requestID,
		"Hostname":    msg.Hostname,
		"Fingerprint": fp,
		"ExpiresAt":   expires,
		"CSRF":        p.csrfFromRequest(r),
	})
}

func (p *Panel) handleCliAuthorizeApprove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	requestID := strings.TrimSpace(r.FormValue("request_id"))
	if requestID == "" {
		http.Redirect(w, r, "/cli/authorize?approve_error=missing+request_id", http.StatusSeeOther)
		return
	}
	resp, err := p.clients.Auth.ApproveLogin(r.Context(),
		connect.NewRequest(&prosav1.ApproveLoginRequest{RequestId: requestID}))
	if err != nil {
		slog.Warn("approve login failed", "request_id", requestID, "err", err)
		http.Redirect(w, r,
			"/cli/authorize?request_id="+url.QueryEscape(requestID)+"&approve_error="+queryEscape(err.Error()),
			http.StatusSeeOther)
		return
	}
	msg := resp.Msg
	target, err := url.Parse(msg.RedirectUri)
	if err != nil {
		http.Error(w, "invalid redirect_uri from server", http.StatusInternalServerError)
		return
	}
	q := target.Query()
	q.Set("code", msg.Code)
	q.Set("state", msg.ClientState)
	target.RawQuery = q.Encode()
	slog.Info("cli login approved", "request_id", requestID, "redirect_host", target.Host)
	http.Redirect(w, r, target.String(), http.StatusFound)
}

func (p *Panel) renderCliAuthorizeError(w http.ResponseWriter, msg string) {
	p.render(w, "cli_authorize", map[string]any{
		"Error": msg,
	})
}
