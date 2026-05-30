// Package handlers binds the Connect-generated service interfaces to
// the prosa internal/server services (auth, sessions, devices).
package handlers

import (
	"context"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/server/auth"
)

// AuthHandler is the Connect implementation backed by *auth.Service.
type AuthHandler struct {
	prosav1connect.UnimplementedAuthServiceHandler
	Svc *auth.Service
}

// NewAuthHandler wires the service into the generated stub. Whoami
// needs the resolved device id from middleware, so the handler reads
// the context the interceptor stamped.
func NewAuthHandler(svc *auth.Service) *AuthHandler {
	return &AuthHandler{Svc: svc}
}

func (h *AuthHandler) StartLogin(ctx context.Context, req *connect.Request[prosav1.StartLoginRequest]) (*connect.Response[prosav1.StartLoginResponse], error) {
	if req.Msg.Hostname == "" || req.Msg.DeviceFingerprint == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, missingFields("hostname", "device_fingerprint"))
	}
	res, err := h.Svc.Start(ctx, req.Msg.Hostname, req.Msg.DeviceFingerprint)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&prosav1.StartLoginResponse{
		UserCode:        res.UserCode,
		DeviceCode:      res.DeviceCode,
		VerificationUri: res.VerificationURI,
		ExpiresIn:       res.ExpiresIn,
		Interval:        res.Interval,
	}), nil
}

func (h *AuthHandler) PollLogin(ctx context.Context, req *connect.Request[prosav1.PollLoginRequest]) (*connect.Response[prosav1.PollLoginResponse], error) {
	if req.Msg.DeviceCode == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, missingFields("device_code"))
	}
	res, err := h.Svc.Poll(ctx, req.Msg.DeviceCode)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&prosav1.PollLoginResponse{
		State:    mapState(res.State),
		Token:    res.Token,
		DeviceId: res.DeviceID,
	}), nil
}

func (h *AuthHandler) ApproveLogin(ctx context.Context, req *connect.Request[prosav1.ApproveLoginRequest]) (*connect.Response[prosav1.ApproveLoginResponse], error) {
	if req.Msg.UserCode == "" || req.Msg.AdminToken == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, missingFields("user_code", "admin_token"))
	}
	deviceID, err := h.Svc.Approve(ctx, req.Msg.UserCode, req.Msg.AdminToken)
	if err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}
	return connect.NewResponse(&prosav1.ApproveLoginResponse{DeviceId: deviceID}), nil
}

func (h *AuthHandler) Whoami(ctx context.Context, _ *connect.Request[prosav1.WhoamiRequest]) (*connect.Response[prosav1.WhoamiResponse], error) {
	deviceID, ok := auth.DeviceFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, missingFields("authorization"))
	}
	var hostname, friendly string
	err := h.Svc.Pool.QueryRow(
		ctx,
		`SELECT hostname, friendly_name FROM devices WHERE id = $1`, deviceID,
	).Scan(&hostname, &friendly)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, connect.NewError(connect.CodeUnauthenticated, missingFields("device row"))
		}
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&prosav1.WhoamiResponse{
		DeviceId:     deviceID,
		Hostname:     hostname,
		FriendlyName: friendly,
	}), nil
}

func mapState(s string) prosav1.PollLoginResponse_State {
	switch s {
	case auth.StatePending:
		return prosav1.PollLoginResponse_STATE_PENDING
	case auth.StateApproved:
		return prosav1.PollLoginResponse_STATE_APPROVED
	case auth.StateDenied:
		return prosav1.PollLoginResponse_STATE_DENIED
	case auth.StateExpired:
		return prosav1.PollLoginResponse_STATE_EXPIRED
	}
	return prosav1.PollLoginResponse_STATE_UNSPECIFIED
}
