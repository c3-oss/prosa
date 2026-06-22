package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/server/auth"
)

func TestAppTokenCanReadAnalyticsOnly(t *testing.T) {
	ctx := context.Background()
	pool := newHandlersPostgresPool(t, ctx)

	const adminToken = "admin-token"
	authSvc := auth.New(pool, adminToken, "http://panel.test")
	_, secret, err := authSvc.CreateAppToken(ctx, "prosa-webp-widgets")
	require.NoError(t, err)

	insertDeviceToken(t, ctx, pool, "device-a", "device-bearer")
	started := time.Date(2026, 6, 1, 9, 0, 0, 0, time.UTC)
	rawSum := sha256.Sum256([]byte("raw-session"))
	_, err = pool.Exec(ctx, `
		INSERT INTO sessions(
			id, agent, device_id, started_at, last_activity_at,
			raw_uri, raw_hash, raw_size
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	`, "s1", "codex", "device-a", started, started.Add(time.Minute),
		"s3://bucket/raw", hex.EncodeToString(rawSum[:]), 11)
	require.NoError(t, err)

	mux := http.NewServeMux()
	anPath, anHandler := prosav1connect.NewAnalyticsServiceHandler(
		NewAnalyticsHandler(pool),
		connect.WithInterceptors(auth.Interceptor(authSvc)),
	)
	mux.Handle(anPath, anHandler)
	sessPath, sessHandler := prosav1connect.NewSessionsServiceHandler(
		NewSessionsHandler(pool, newTestObjectStore(t)),
		connect.WithInterceptors(auth.Interceptor(authSvc)),
	)
	mux.Handle(sessPath, sessHandler)

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	anClient := prosav1connect.NewAnalyticsServiceClient(server.Client(), server.URL)
	reportReq := connect.NewRequest(&prosav1.GetReportRequest{
		Report: "sessions",
		Since:  timestamppb.New(started.Add(-time.Hour)),
		Until:  timestamppb.New(started.Add(time.Hour)),
	})
	reportReq.Header().Set("Authorization", "App "+secret)
	report, err := anClient.GetReport(ctx, reportReq)
	require.NoError(t, err)
	require.Equal(t, []string{"AGENT", "SESSIONS", "TURNS"}, report.Msg.Headers)
	require.Len(t, report.Msg.Rows, 1)
	require.Equal(t, []string{"codex", "1", "0"}, report.Msg.Rows[0].Values)

	sessClient := prosav1connect.NewSessionsServiceClient(server.Client(), server.URL)
	listReq := connect.NewRequest(&prosav1.ListRequest{Limit: 10})
	listReq.Header().Set("Authorization", "App "+secret)
	_, err = sessClient.List(ctx, listReq)
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
}
