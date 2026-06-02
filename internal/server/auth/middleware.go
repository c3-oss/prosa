package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"strings"

	"connectrpc.com/connect"
)

// ctxKey is the unexported context key for the resolved device id.
type ctxKey struct{}

// ownerKey is the unexported context key for the owner-caller flag.
// The panel attaches this by presenting `Authorization: Admin <token>`;
// device callers (bearer) never see it.
type ownerKey struct{}

// DeviceFromContext returns the device id stamped by Interceptor. The
// caller MUST treat a missing value as an unauthenticated condition.
func DeviceFromContext(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(ctxKey{}).(string)
	return v, ok && v != ""
}

// IsOwner returns true when the caller authenticated via the admin
// header (panel-to-server). Owner callers bypass device scoping in
// List/Get/Search/Devices/GetRaw/Analytics.
func IsOwner(ctx context.Context) bool {
	v, _ := ctx.Value(ownerKey{}).(bool)
	return v
}

// withDevice attaches deviceID to the context.
func withDevice(ctx context.Context, deviceID string) context.Context {
	return context.WithValue(ctx, ctxKey{}, deviceID)
}

// withOwner stamps the owner-caller flag on the context.
func withOwner(ctx context.Context) context.Context {
	return context.WithValue(ctx, ownerKey{}, true)
}

// PublicRPCs are the procedure paths that skip bearer enforcement.
// Anything not in this set must present a valid Authorization header.
var PublicRPCs = map[string]struct{}{
	"/prosa.v1.HealthService/Check":      {},
	"/prosa.v1.AuthService/BeginLogin":   {},
	"/prosa.v1.AuthService/ExchangeCode": {},
}

// Interceptor is a Connect unary interceptor that pulls the bearer
// from the request, resolves it to a device_id, and stamps the
// context. Public RPCs pass through untouched. Admin callers (panel)
// present `Authorization: Admin <PROSA_ADMIN_TOKEN>` and get an
// owner-flagged context with no device id.
func Interceptor(svc *Service) connect.UnaryInterceptorFunc {
	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return connect.UnaryFunc(func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			if _, public := PublicRPCs[req.Spec().Procedure]; public {
				return next(ctx, req)
			}
			h := req.Header().Get("Authorization")
			if tok, ok := adminToken(h); ok {
				if !svc.IsAdminToken(tok) {
					return nil, connect.NewError(connect.CodeUnauthenticated,
						errors.New("admin token mismatch"))
				}
				return next(withOwner(ctx), req)
			}
			bearer, ok := bearerToken(h)
			if !ok {
				return nil, connect.NewError(connect.CodeUnauthenticated,
					errors.New("missing or malformed Authorization header"))
			}
			deviceID, err := svc.DeviceFromBearer(ctx, bearer)
			if err != nil {
				return nil, connect.NewError(connect.CodeUnauthenticated, err)
			}
			return next(withDevice(ctx, deviceID), req)
		})
	}
}

// IsAdminToken is a constant-time comparison helper used by the
// interceptor; exposed so handlers that want to gate explicit admin
// paths (e.g. ApproveLogin) can reuse the same check.
func (s *Service) IsAdminToken(tok string) bool {
	if s.AdminToken == "" || tok == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(tok), []byte(s.AdminToken)) == 1
}

// bearerToken extracts the raw token from "Bearer <token>", trimming
// whitespace and matching case-insensitively on the scheme.
func bearerToken(h string) (string, bool) {
	return schemeToken(h, "bearer ")
}

// adminToken extracts the raw token from "Admin <token>" — the
// panel-to-server auth handshake.
func adminToken(h string) (string, bool) {
	return schemeToken(h, "admin ")
}

func schemeToken(h, prefix string) (string, bool) {
	if h == "" {
		return "", false
	}
	if len(h) <= len(prefix) {
		return "", false
	}
	if !strings.EqualFold(h[:len(prefix)], prefix) {
		return "", false
	}
	tok := strings.TrimSpace(h[len(prefix):])
	if tok == "" {
		return "", false
	}
	return tok, true
}
