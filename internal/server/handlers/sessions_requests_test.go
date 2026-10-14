package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/pkg/session"
)

func TestPushRequestProjectionAndLegacyDowngrade(t *testing.T) {
	ctx := context.Background()
	pool := newHandlersPostgresPool(t, ctx)
	insertDeviceToken(t, ctx, pool, "device-a", pushChunkBearer)
	client := newPushClient(t, pool, newTestObjectStore(t), "admin-token")
	at := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	raw := []byte("request transcript")
	s := chunkSession("requests-a", at, int64(len(raw)), sha256Hex(raw))
	s.Model = "gpt-6.1-sol"
	s.Usage = &prosav1.TokenUsage{InputTokens: 400000, TotalTokens: 400000}
	push := func(s *prosav1.Session, calls []*prosav1.RequestUsage) *prosav1.PushResponse {
		t.Helper()
		req := connect.NewRequest(&prosav1.PushRequest{
			Session: s, Raw: raw, Requests: calls,
			Turns: []*prosav1.Turn{{Role: "user", Content: "request pricing", Ts: timestamppb.New(at)}},
		})
		req.Header().Set("Authorization", "Bearer "+pushChunkBearer)
		resp, err := client.Push(ctx, req)
		require.NoError(t, err)
		return resp.Msg
	}
	get := func() *prosav1.Session {
		t.Helper()
		req := connect.NewRequest(&prosav1.GetRequest{Id: s.Id})
		req.Header().Set("Authorization", "Bearer "+pushChunkBearer)
		resp, err := client.Get(ctx, req)
		require.NoError(t, err)
		return resp.Msg.Session
	}
	require.False(t, push(proto.Clone(s).(*prosav1.Session), nil).Skipped)
	legacy := get()
	require.EqualValues(t, 13, legacy.ProjectionVersion)
	require.Equal(t, session.CostEstimated, legacy.Cost.Status)
	require.InDelta(t, .8, *legacy.Cost.Usd, 1e-10)

	standard, global := "standard", "global"
	promptA, promptB, zero := int64(300000), int64(100000), int64(0)
	calls := []*prosav1.RequestUsage{
		{
			Id: "first", Model: "gpt-6.1-sol", Timestamp: timestamppb.New(at), PromptTokens: &promptA,
			Usage: &prosav1.TokenUsage{InputTokens: promptA, TotalTokens: promptA}, ServiceTier: &standard, Speed: &standard, InferenceGeo: &global,
		},
		{
			Id: "second", Model: "claude-haiku-5-5", Timestamp: timestamppb.New(at.Add(time.Minute)), PromptTokens: &promptB,
			Usage: &prosav1.TokenUsage{InputTokens: promptB, TotalTokens: promptB}, ServiceTier: &standard, Speed: &standard, InferenceGeo: &global,
			CacheCreation_5MTokens: &zero, CacheCreation_1HTokens: &zero,
		},
	}
	s.ProjectionVersion, s.RequestCoverage = session.ProjectionVersion, session.RequestCoverageComplete
	forged := 999.0
	s.Cost = &prosav1.CostSummary{Usd: &forged, Status: session.CostCalculated}
	require.False(t, push(s, calls).Skipped)
	projected := get()
	require.EqualValues(t, 14, projected.ProjectionVersion)
	require.Equal(t, session.RequestCoverageComplete, projected.RequestCoverage)
	require.Equal(t, session.CostCalculated, projected.Cost.Status)
	require.InDelta(t, 1.21, *projected.Cost.Usd, 1e-10)
	require.EqualValues(t, 400000, projected.Cost.PricedTokens)

	var payload []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT payload FROM session_requests WHERE session_id=$1 AND ordinal=0`, s.Id).Scan(&payload))
	var first session.RequestUsage
	require.NoError(t, json.Unmarshal(payload, &first))
	require.Equal(t, promptA, *first.PromptTokens)
	require.Nil(t, first.CacheCreation1hTokens)
	require.NoError(t, pool.QueryRow(ctx, `SELECT payload FROM session_requests WHERE session_id=$1 AND ordinal=1`, s.Id).Scan(&payload))
	var second session.RequestUsage
	require.NoError(t, json.Unmarshal(payload, &second))
	require.NotNil(t, second.CacheCreation1hTokens)
	require.Zero(t, *second.CacheCreation1hTokens)

	old := proto.Clone(s).(*prosav1.Session)
	old.ProjectionVersion, old.RequestCoverage, old.Usage = 0, "", nil
	require.True(t, push(old, nil).Skipped)
	require.Equal(t, projected.Cost, get().Cost)

	listReq := connect.NewRequest(&prosav1.ListRequest{Since: timestamppb.New(at.Add(-time.Hour)), Until: timestamppb.New(at.Add(time.Hour))})
	listReq.Header().Set("Authorization", "Bearer "+pushChunkBearer)
	listed, err := client.List(ctx, listReq)
	require.NoError(t, err)
	require.Equal(t, projected.Cost, listed.Msg.Sessions[0].Cost)
	searchReq := connect.NewRequest(&prosav1.SearchRequest{Query: "pricing", Since: listReq.Msg.Since, Until: listReq.Msg.Until})
	searchReq.Header().Set("Authorization", "Bearer "+pushChunkBearer)
	searched, err := client.Search(ctx, searchReq)
	require.NoError(t, err)
	require.Equal(t, projected.Cost, searched.Msg.Hits[0].Session.Cost)

	an := NewAnalyticsHandler(pool)
	for _, report := range []string{"usage", "usage_by_model", "usage_by_day", "subagent_usage_by_day", "profile_usage"} {
		resp, err := runPricedUsage(ctx, an.Pool, &prosav1.GetReportRequest{Report: report, Since: listReq.Msg.Since, Until: listReq.Msg.Until})
		require.NoError(t, err)
		var sum float64
		for _, row := range resp.Msg.Rows {
			n := len(row.Values)
			require.Equal(t, session.CostCalculated, row.Values[n-3])
			var cost float64
			_, err := fmt.Sscan(row.Values[n-4], &cost)
			require.NoError(t, err)
			sum += cost
		}
		require.InDelta(t, 1.21, sum, 1e-10, report)
		if report == "usage_by_model" {
			require.Len(t, resp.Msg.Rows, 2)
		}
	}
}

func TestPushChunkPreservesRequestFacts(t *testing.T) {
	ctx := context.Background()
	pool := newHandlersPostgresPool(t, ctx)
	insertDeviceToken(t, ctx, pool, "device-a", pushChunkBearer)
	client := newPushClient(t, pool, newTestObjectStore(t), "admin-token")
	at := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	raw := []byte("chunked requests")
	s := chunkSession("chunked-requests", at, int64(len(raw)), sha256Hex(raw))
	input := int64(1000)
	standard, global := "standard", "global"
	s.Model, s.ProjectionVersion, s.RequestCoverage = "gpt-6.1-sol", 14, session.RequestCoverageComplete
	s.Usage = &prosav1.TokenUsage{InputTokens: input, TotalTokens: input}
	_, err := sendChunk(ctx, client, &prosav1.PushChunkRequest{Session: s, RawChunk: raw[:5]})
	require.NoError(t, err)
	_, err = sendChunk(ctx, client, &prosav1.PushChunkRequest{
		Session: s, Offset: 5, RawChunk: raw[5:], Final: true,
		Requests: []*prosav1.RequestUsage{{
			Id: "request", Model: s.Model, Usage: s.Usage, Timestamp: timestamppb.New(at),
			PromptTokens: &input, ServiceTier: &standard, Speed: &standard, InferenceGeo: &global,
		}},
	})
	require.NoError(t, err)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM session_requests WHERE session_id=$1`, s.Id).Scan(&count))
	require.Equal(t, 1, count)

	req := connect.NewRequest(&prosav1.GetRequest{Id: s.Id})
	req.Header().Set("Authorization", "Bearer "+pushChunkBearer)
	resp, err := client.Get(ctx, req)
	require.NoError(t, err)
	require.Equal(t, session.CostCalculated, resp.Msg.Session.Cost.Status)
	require.InDelta(t, .002, *resp.Msg.Session.Cost.Usd, 1e-10)
}
