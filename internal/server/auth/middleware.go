package auth

import (
	"context"
	"errors"
	"strings"

	"connectrpc.com/connect"
)

// ctxKey is the unexported context key for the resolved device id.
type ctxKey struct{}

// DeviceFromContext returns the device id stamped by Interceptor. The
// caller MUST treat a missing value as an unauthenticated condition.
func DeviceFromContext(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(ctxKey{}).(string)
	return v, ok && v != ""
}

// withDevice attaches deviceID to the context.
func withDevice(ctx context.Context, deviceID string) context.Context {
	return context.WithValue(ctx, ctxKey{}, deviceID)
}

// PublicRPCs are the procedure paths that skip bearer enforcement.
// Anything not in this set must present a valid Authorization header.
var PublicRPCs = map[string]struct{}{
	"/prosa.v1.HealthService/Check":      {},
	"/prosa.v1.AuthService/StartLogin":   {},
	"/prosa.v1.AuthService/PollLogin":    {},
	"/prosa.v1.AuthService/ApproveLogin": {},
}

// Interceptor is a Connect unary interceptor that pulls the bearer
// from the request, resolves it to a device_id, and stamps the
// context. Public RPCs pass through untouched.
func Interceptor(svc *Service) connect.UnaryInterceptorFunc {
	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return connect.UnaryFunc(func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			if _, public := PublicRPCs[req.Spec().Procedure]; public {
				return next(ctx, req)
			}
			h := req.Header().Get("Authorization")
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

// bearerToken extracts the raw token from "Bearer <token>", trimming
// whitespace and matching case-insensitively on the scheme.
func bearerToken(h string) (string, bool) {
	if h == "" {
		return "", false
	}
	const prefix = "bearer "
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
