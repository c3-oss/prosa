// Package handlers binds the Connect-generated service interfaces to
// the prosa internal/server services (auth, sessions, devices).
package handlers

import (
	"context"
	"errors"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/server/auth"
)

// AuthHandler is the Connect implementation backed by *auth.Service.
type AuthHandler struct {
	prosav1connect.UnimplementedAuthServiceHandler
	Svc *auth.Service
}

// NewAuthHandler wires the service into the generated stub.
func NewAuthHandler(svc *auth.Service) *AuthHandler {
	return &AuthHandler{Svc: svc}
}

func (h *AuthHandler) BeginLogin(ctx context.Context, req *connect.Request[prosav1.BeginLoginRequest]) (*connect.Response[prosav1.BeginLoginResponse], error) {
	if req.Msg.Hostname == "" || req.Msg.DeviceFingerprint == "" ||
		req.Msg.CodeChallenge == "" || req.Msg.RedirectUri == "" || req.Msg.ClientState == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			missingFields("hostname", "device_fingerprint", "code_challenge", "redirect_uri", "client_state"))
	}
	res, err := h.Svc.Begin(ctx,
		req.Msg.Hostname, req.Msg.DeviceFingerprint,
		req.Msg.CodeChallenge, req.Msg.RedirectUri, req.Msg.ClientState)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	return connect.NewResponse(&prosav1.BeginLoginResponse{
		AuthorizeUrl: res.AuthorizeURL,
		RequestId:    res.RequestID,
		ExpiresIn:    res.ExpiresIn,
	}), nil
}

func (h *AuthHandler) ExchangeCode(ctx context.Context, req *connect.Request[prosav1.ExchangeCodeRequest]) (*connect.Response[prosav1.ExchangeCodeResponse], error) {
	if req.Msg.Code == "" || req.Msg.CodeVerifier == "" || req.Msg.RedirectUri == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			missingFields("code", "code_verifier", "redirect_uri"))
	}
	res, err := h.Svc.Exchange(ctx, req.Msg.Code, req.Msg.CodeVerifier, req.Msg.RedirectUri)
	if err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}
	return connect.NewResponse(&prosav1.ExchangeCodeResponse{
		Token:    res.Token,
		DeviceId: res.DeviceID,
	}), nil
}

func (h *AuthHandler) GetLoginRequest(ctx context.Context, req *connect.Request[prosav1.GetLoginRequestRequest]) (*connect.Response[prosav1.GetLoginRequestResponse], error) {
	if !auth.IsOwner(ctx) {
		return nil, connect.NewError(connect.CodeUnauthenticated, missingFields("authorization"))
	}
	if req.Msg.RequestId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, missingFields("request_id"))
	}
	res, err := h.Svc.GetRequest(ctx, req.Msg.RequestId)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}
	return connect.NewResponse(&prosav1.GetLoginRequestResponse{
		Hostname:    res.Hostname,
		Fingerprint: res.Fingerprint,
		ExpiresAt:   timestamppb.New(res.ExpiresAt),
		State:       res.State,
	}), nil
}

func (h *AuthHandler) ApproveLogin(ctx context.Context, req *connect.Request[prosav1.ApproveLoginRequest]) (*connect.Response[prosav1.ApproveLoginResponse], error) {
	if !auth.IsOwner(ctx) {
		return nil, connect.NewError(connect.CodeUnauthenticated, missingFields("authorization"))
	}
	if req.Msg.RequestId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, missingFields("request_id"))
	}
	res, err := h.Svc.Approve(ctx, req.Msg.RequestId)
	if err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}
	return connect.NewResponse(&prosav1.ApproveLoginResponse{
		Code:        res.Code,
		RedirectUri: res.RedirectURI,
		ClientState: res.ClientState,
	}), nil
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
		if errors.Is(err, pgx.ErrNoRows) {
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
