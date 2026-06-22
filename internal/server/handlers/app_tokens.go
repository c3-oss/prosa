package handlers

import (
	"context"
	"errors"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/server/auth"
)

// AppTokensHandler implements owner-managed application tokens.
type AppTokensHandler struct {
	prosav1connect.UnimplementedAppTokensServiceHandler
	Svc *auth.Service
}

func NewAppTokensHandler(svc *auth.Service) *AppTokensHandler {
	return &AppTokensHandler{Svc: svc}
}

func (h *AppTokensHandler) Create(ctx context.Context, req *connect.Request[prosav1.AppTokensServiceCreateRequest]) (*connect.Response[prosav1.AppTokensServiceCreateResponse], error) {
	if !auth.IsOwner(ctx) {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("owner context required"))
	}
	tok, secret, err := h.Svc.CreateAppToken(ctx, req.Msg.Name)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	return connect.NewResponse(&prosav1.AppTokensServiceCreateResponse{
		Token:  appTokenProto(tok),
		Secret: secret,
	}), nil
}

func (h *AppTokensHandler) List(ctx context.Context, _ *connect.Request[prosav1.AppTokensServiceListRequest]) (*connect.Response[prosav1.AppTokensServiceListResponse], error) {
	if !auth.IsOwner(ctx) {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("owner context required"))
	}
	tokens, err := h.Svc.ListAppTokens(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	out := &prosav1.AppTokensServiceListResponse{}
	for _, tok := range tokens {
		out.Tokens = append(out.Tokens, appTokenProto(tok))
	}
	return connect.NewResponse(out), nil
}

func (h *AppTokensHandler) Revoke(ctx context.Context, req *connect.Request[prosav1.AppTokensServiceRevokeRequest]) (*connect.Response[prosav1.AppTokensServiceRevokeResponse], error) {
	if !auth.IsOwner(ctx) {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("owner context required"))
	}
	if req.Msg.Id == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, missingFields("id"))
	}
	if err := h.Svc.RevokeAppToken(ctx, req.Msg.Id); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&prosav1.AppTokensServiceRevokeResponse{}), nil
}

func appTokenProto(tok auth.AppTokenRecord) *prosav1.AppToken {
	out := &prosav1.AppToken{
		Id:        tok.ID,
		Name:      tok.Name,
		CreatedAt: timestamppb.New(tok.CreatedAt),
	}
	if tok.LastUsedAt != nil {
		out.LastUsedAt = timestamppb.New(*tok.LastUsedAt)
	}
	if tok.RevokedAt != nil {
		out.RevokedAt = timestamppb.New(*tok.RevokedAt)
	}
	return out
}
