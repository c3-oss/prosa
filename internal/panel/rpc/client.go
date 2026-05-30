// Package rpc wraps the Connect clients the panel uses to call
// prosa-server, pre-injecting the "Authorization: Admin <token>"
// header so handlers don't need to remember it.
package rpc

import (
	"net/http"

	"connectrpc.com/connect"

	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
)

// Clients bundles every server RPC the panel ever calls. Constructed
// once at boot.
type Clients struct {
	Sessions  prosav1connect.SessionsServiceClient
	Devices   prosav1connect.DevicesServiceClient
	Auth      prosav1connect.AuthServiceClient
	Analytics prosav1connect.AnalyticsServiceClient
}

// New builds a Clients tied to serverURL, attaching the admin token on
// every request via an HTTP RoundTripper. The HTTP client supports
// HTTP/2 over h2c (server in dev) automatically through Connect's
// default transport.
func New(serverURL, adminToken string) *Clients {
	hc := &http.Client{
		Transport: &adminTransport{
			token: adminToken,
			base:  http.DefaultTransport,
		},
	}
	return &Clients{
		Sessions:  prosav1connect.NewSessionsServiceClient(hc, serverURL),
		Devices:   prosav1connect.NewDevicesServiceClient(hc, serverURL),
		Auth:      prosav1connect.NewAuthServiceClient(hc, serverURL),
		Analytics: prosav1connect.NewAnalyticsServiceClient(hc, serverURL),
	}
}

// adminTransport stamps every request with the panel's admin token so
// the server recognizes the caller as owner.
type adminTransport struct {
	token string
	base  http.RoundTripper
}

func (t *adminTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	req.Header.Set("Authorization", "Admin "+t.token)
	return t.base.RoundTrip(req)
}

// Code wraps connect.CodeOf for convenience in handlers that want to
// decide whether to retry vs surface an error verbatim.
func Code(err error) connect.Code {
	return connect.CodeOf(err)
}
