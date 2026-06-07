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

// TestAnalyticsReportsEndToEnd validates the three new Postgres reports
// (hours, usage_by_model, errors_by_model) against real Postgres, asserting
// they match the shapes the SQLite store emits. Skips without
// PROSA_TEST_PG_URL.
func TestAnalyticsReportsEndToEnd(t *testing.T) {
	ctx := context.Background()
	pool := newHandlersPostgresPool(t, ctx)
	obj := newTestObjectStore(t)

	const (
		adminToken = "admin-token"
		bearer     = "device-bearer"
		deviceID   = "device-a"
	)
	insertDeviceToken(t, ctx, pool, deviceID, bearer)

	mux := http.NewServeMux()
	authSvc := auth.New(pool, adminToken, "http://panel.test")
	sessPath, sessHandler := prosav1connect.NewSessionsServiceHandler(
		NewSessionsHandler(pool, obj),
		connect.WithInterceptors(auth.Interceptor(authSvc)),
	)
	mux.Handle(sessPath, sessHandler)
	anPath, anHandler := prosav1connect.NewAnalyticsServiceHandler(
		NewAnalyticsHandler(pool),
		connect.WithInterceptors(auth.Interceptor(authSvc)),
	)
	mux.Handle(anPath, anHandler)

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	sessClient := prosav1connect.NewSessionsServiceClient(server.Client(), server.URL)
	anClient := prosav1connect.NewAnalyticsServiceClient(server.Client(), server.URL)

	day := time.Date(2026, 5, 30, 0, 0, 0, 0, time.UTC)
	push := func(id, model string, hour int, assistant string) {
		t.Helper()
		started := day.Add(time.Duration(hour) * time.Hour)
		raw := []byte("raw-" + id)
		rawSum := sha256.Sum256(raw)
		rawHash := hex.EncodeToString(rawSum[:])
		req := connect.NewRequest(&prosav1.PushRequest{
			Session: &prosav1.Session{
				Id:             id,
				Agent:          "claude-code",
				StartedAt:      timestamppb.New(started),
				LastActivityAt: timestamppb.New(started.Add(time.Minute)),
				Model:          model,
				RawHash:        rawHash,
				RawSize:        int64(len(raw)),
				Usage: &prosav1.TokenUsage{
					TotalTokens:  1000,
					InputTokens:  800,
					OutputTokens: 200,
				},
			},
			Turns: []*prosav1.Turn{
				{Role: "user", Content: "do it", Ts: timestamppb.New(started)},
				{Role: "assistant", Content: assistant, Ts: timestamppb.New(started.Add(time.Minute))},
			},
			Raw: raw,
		})
		req.Header().Set("Authorization", "Bearer "+bearer)
		_, err := sessClient.Push(ctx, req)
		require.NoError(t, err)
	}

	push("s1", "claude-opus-4-5", 9, "all good, shipped clean")
	push("s2", "claude-opus-4-5", 9, "panic: something failed badly")
	push("s3", "gpt-5-codex", 14, "looks fine to me")

	report := func(name string) *prosav1.GetReportResponse {
		t.Helper()
		req := connect.NewRequest(&prosav1.GetReportRequest{
			Report: name,
			Since:  timestamppb.New(day.Add(-time.Hour)),
			Until:  timestamppb.New(day.Add(48 * time.Hour)),
		})
		req.Header().Set("Authorization", "Bearer "+bearer)
		resp, err := anClient.GetReport(ctx, req)
		require.NoError(t, err)
		return resp.Msg
	}

	rowMap := func(resp *prosav1.GetReportResponse) map[string][]string {
		out := map[string][]string{}
		for _, row := range resp.Rows {
			out[row.Values[0]] = row.Values
		}
		return out
	}

	hours := report("hours")
	require.Equal(t, []string{"HOUR", "SESSIONS"}, hours.Headers)
	h := rowMap(hours)
	require.Equal(t, "2", h["09"][1])
	require.Equal(t, "1", h["14"][1])

	usage := report("usage_by_model")
	require.Equal(t, []string{"MODEL", "SESSIONS", "TOTAL", "INPUT", "OUTPUT", "EST_COST_USD"}, usage.Headers)
	u := rowMap(usage)
	require.Equal(t, "2", u["claude-opus-4-5"][1])    // sessions
	require.Equal(t, "2000", u["claude-opus-4-5"][2]) // total tokens
	require.NotEmpty(t, u["claude-opus-4-5"][5])      // est cost — priced model
	require.Equal(t, "1", u["gpt-5-codex"][1])

	errs := report("errors_by_model")
	require.Equal(t, []string{"MODEL", "SESSIONS"}, errs.Headers)
	e := rowMap(errs)
	require.Equal(t, "1", e["claude-opus-4-5"][1]) // only s2 has trigger words
	_, codexFlagged := e["gpt-5-codex"]
	require.False(t, codexFlagged)
}
