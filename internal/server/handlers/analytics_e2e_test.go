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

// TestInsightsReportsEndToEnd validates the panel-only insights reports
// (usage_by_day, punchcard, durations, duration_stats, subagents)
// against real Postgres. Skips without PROSA_TEST_PG_URL.
func TestInsightsReportsEndToEnd(t *testing.T) {
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

	// 2026-05-30 is a Saturday (DOW=6); +1d Sunday (0); +2d Monday (1).
	saturday := time.Date(2026, 5, 30, 0, 0, 0, 0, time.UTC)
	push := func(id, agent, model string, started time.Time, dur time.Duration, parent string) {
		t.Helper()
		raw := []byte("raw-" + id)
		rawSum := sha256.Sum256(raw)
		req := connect.NewRequest(&prosav1.PushRequest{
			Session: &prosav1.Session{
				Id:              id,
				Agent:           agent,
				StartedAt:       timestamppb.New(started),
				LastActivityAt:  timestamppb.New(started.Add(dur)),
				Model:           model,
				RawHash:         hex.EncodeToString(rawSum[:]),
				RawSize:         int64(len(raw)),
				ParentSessionId: parent,
				Usage: &prosav1.TokenUsage{
					TotalTokens:  1000,
					InputTokens:  800,
					OutputTokens: 200,
				},
			},
			Turns: []*prosav1.Turn{
				{Role: "user", Content: "do it", Ts: timestamppb.New(started)},
				{Role: "assistant", Content: "done", Ts: timestamppb.New(started.Add(dur))},
			},
			Raw: raw,
		})
		req.Header().Set("Authorization", "Bearer "+bearer)
		_, err := sessClient.Push(ctx, req)
		require.NoError(t, err)
	}

	// Saturday 09h: one parent that spawned two short-lived children.
	push("p1", "claude-code", "claude-opus-4-5", saturday.Add(9*time.Hour), 10*time.Minute, "")
	push("c1", "claude-code", "claude-opus-4-5", saturday.Add(9*time.Hour+5*time.Minute), 2*time.Minute, "p1")
	push("c2", "claude-code", "claude-opus-4-5", saturday.Add(9*time.Hour+10*time.Minute), 2*time.Minute, "p1")
	// Sunday 14h and Monday 23h: standalone codex sessions.
	push("s4", "codex", "gpt-5-codex", saturday.Add(24*time.Hour+14*time.Hour), 90*time.Minute, "")
	push("s5", "codex", "gpt-5-codex", saturday.Add(48*time.Hour+23*time.Hour), 3*time.Hour, "")

	report := func(name string) *prosav1.GetReportResponse {
		t.Helper()
		req := connect.NewRequest(&prosav1.GetReportRequest{
			Report: name,
			Since:  timestamppb.New(saturday.Add(-time.Hour)),
			Until:  timestamppb.New(saturday.Add(96 * time.Hour)),
		})
		req.Header().Set("Authorization", "Bearer "+bearer)
		resp, err := anClient.GetReport(ctx, req)
		require.NoError(t, err)
		return resp.Msg
	}

	usage := report("usage_by_day")
	require.Equal(t,
		[]string{"DAY", "MODEL", "SESSIONS", "MEASURED", "TOTAL", "INPUT", "OUTPUT", "CACHED", "CACHE_READ", "CACHE_CREATION"},
		usage.Headers)
	byDayModel := map[string][]string{}
	for _, row := range usage.Rows {
		byDayModel[row.Values[0]+"|"+row.Values[1]] = row.Values
	}
	sat := byDayModel["2026-05-30|claude-opus-4-5"]
	require.NotNil(t, sat)
	require.Equal(t, "3", sat[2])    // parent + two children
	require.Equal(t, "3000", sat[4]) // summed total tokens
	sun := byDayModel["2026-05-31|gpt-5-codex"]
	require.NotNil(t, sun)
	require.Equal(t, "1", sun[2])

	punch := report("punchcard")
	require.Equal(t, []string{"DOW", "HOUR", "SESSIONS"}, punch.Headers)
	cells := map[string]string{}
	for _, row := range punch.Rows {
		cells[row.Values[0]+"|"+row.Values[1]] = row.Values[2]
	}
	require.Equal(t, "3", cells["6|09"]) // Saturday 09h UTC
	require.Equal(t, "1", cells["0|14"]) // Sunday 14h
	require.Equal(t, "1", cells["1|23"]) // Monday 23h

	durations := report("durations")
	require.Equal(t, []string{"BUCKET", "SESSIONS"}, durations.Headers)
	buckets := map[string]string{}
	for _, row := range durations.Rows {
		buckets[row.Values[0]] = row.Values[1]
	}
	require.Equal(t, "2", buckets["<5m"])
	require.Equal(t, "1", buckets["5-15m"])
	require.Equal(t, "1", buckets["1-2h"])
	require.Equal(t, "1", buckets[">2h"])

	stats := report("duration_stats")
	require.Equal(t, []string{"MEDIAN_S", "P90_S", "AVG_S", "MAX_S"}, stats.Headers)
	require.Len(t, stats.Rows, 1)
	// Durations in seconds: 120, 120, 600, 5400, 10800.
	require.Equal(t, "600", stats.Rows[0].Values[0])
	require.Equal(t, "8640", stats.Rows[0].Values[1])
	require.Equal(t, "3408", stats.Rows[0].Values[2])
	require.Equal(t, "10800", stats.Rows[0].Values[3])

	subs := report("subagents")
	require.Equal(t, []string{"AGENT", "PARENTS", "CHILDREN", "MAX_FANOUT"}, subs.Headers)
	require.Len(t, subs.Rows, 1)
	require.Equal(t, []string{"claude-code", "1", "2", "2"}, subs.Rows[0].Values)
}
