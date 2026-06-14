package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/server/auth"
)

// TestPreferencesConnectEndToEnd exercises Get/Set against real Postgres
// through the Connect stack, including the owner-only gate. Skips without
// PROSA_TEST_PG_URL.
func TestPreferencesConnectEndToEnd(t *testing.T) {
	ctx := context.Background()
	pool := newHandlersPostgresPool(t, ctx)

	const (
		adminToken = "admin-token"
		bearer     = "device-bearer"
		deviceID   = "device-a"
		owner      = "hi@caian.org"
	)
	insertDeviceToken(t, ctx, pool, deviceID, bearer)

	mux := http.NewServeMux()
	authSvc := auth.New(pool, adminToken, "http://panel.test")
	path, handler := prosav1connect.NewPreferencesServiceHandler(
		NewPreferencesHandler(pool),
		connect.WithInterceptors(auth.Interceptor(authSvc)),
	)
	mux.Handle(path, handler)

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	client := prosav1connect.NewPreferencesServiceClient(server.Client(), server.URL)

	owned := func(req connect.AnyRequest) {
		req.Header().Set("Authorization", "Admin "+adminToken)
	}

	// Unset → empty map.
	getReq := connect.NewRequest(&prosav1.PreferencesServiceGetRequest{OwnerEmail: owner})
	owned(getReq)
	getResp, err := client.Get(ctx, getReq)
	require.NoError(t, err)
	require.Empty(t, getResp.Msg.Preferences)

	// Set then read back.
	setReq := connect.NewRequest(&prosav1.PreferencesServiceSetRequest{OwnerEmail: owner, Key: "theme", Value: "dracula"})
	owned(setReq)
	_, err = client.Set(ctx, setReq)
	require.NoError(t, err)

	getReq2 := connect.NewRequest(&prosav1.PreferencesServiceGetRequest{OwnerEmail: owner})
	owned(getReq2)
	getResp2, err := client.Get(ctx, getReq2)
	require.NoError(t, err)
	require.Equal(t, "dracula", getResp2.Msg.Preferences["theme"])

	// Upsert overwrites in place.
	setReq2 := connect.NewRequest(&prosav1.PreferencesServiceSetRequest{OwnerEmail: owner, Key: "theme", Value: "nord"})
	owned(setReq2)
	_, err = client.Set(ctx, setReq2)
	require.NoError(t, err)

	getReq3 := connect.NewRequest(&prosav1.PreferencesServiceGetRequest{OwnerEmail: owner})
	owned(getReq3)
	getResp3, err := client.Get(ctx, getReq3)
	require.NoError(t, err)
	require.Equal(t, "nord", getResp3.Msg.Preferences["theme"])

	// Missing value is rejected.
	badReq := connect.NewRequest(&prosav1.PreferencesServiceSetRequest{OwnerEmail: owner, Key: "theme"})
	owned(badReq)
	_, err = client.Set(ctx, badReq)
	require.Error(t, err)
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))

	// A device caller (non-owner) is denied even with a valid bearer.
	deviceReq := connect.NewRequest(&prosav1.PreferencesServiceSetRequest{OwnerEmail: owner, Key: "theme", Value: "gruvbox"})
	deviceReq.Header().Set("Authorization", "Bearer "+bearer)
	_, err = client.Set(ctx, deviceReq)
	require.Error(t, err)
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
}
