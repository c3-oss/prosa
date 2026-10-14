package handlers

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/pricing"
	"github.com/c3-oss/prosa/pkg/session"
)

func domainSession(s *prosav1.Session) session.Session {
	out := session.Session{
		ID: s.Id, Agent: s.Agent, DeviceID: s.DeviceId, Profile: s.Profile,
		StartedAt: s.StartedAt.AsTime(), LastActivityAt: s.LastActivityAt.AsTime(),
		RequestCoverage: s.RequestCoverage, ProjectionVersion: int(s.ProjectionVersion),
	}
	if s.Model != "" {
		out.Model = &s.Model
	}
	if s.Usage != nil {
		u := domainUsage(s.Usage)
		out.Usage = &u
	}
	return out
}

func domainUsage(u *prosav1.TokenUsage) session.TokenUsage {
	return session.TokenUsage{
		TotalTokens: u.GetTotalTokens(), InputTokens: u.GetInputTokens(), OutputTokens: u.GetOutputTokens(),
		CachedTokens: u.GetCachedTokens(), CacheReadTokens: u.GetCacheReadTokens(), CacheCreationTokens: u.GetCacheCreationTokens(),
	}
}

func domainRequest(r *prosav1.RequestUsage) session.RequestUsage {
	out := session.RequestUsage{
		ID: r.Id, Model: r.Model, Usage: domainUsage(r.Usage), PromptTokens: r.PromptTokens,
		Provider: r.Provider, ServiceTier: r.ServiceTier, Speed: r.Speed, InferenceGeo: r.InferenceGeo,
		CacheCreation5mTokens: r.CacheCreation_5MTokens, CacheCreation1hTokens: r.CacheCreation_1HTokens,
	}
	if r.Timestamp != nil {
		t := r.Timestamp.AsTime()
		out.Timestamp = &t
	}
	return out
}

func validateRequests(s *prosav1.Session, requests []*prosav1.RequestUsage) error {
	var sum session.TokenUsage
	for i, request := range requests {
		if request == nil || request.Usage == nil {
			return fmt.Errorf("request %d has no usage", i)
		}
		if request.Timestamp != nil {
			if err := request.Timestamp.CheckValid(); err != nil {
				return fmt.Errorf("request %d timestamp: %w", i, err)
			}
		}
		u := domainUsage(request.Usage)
		for _, value := range []int64{u.InputTokens, u.OutputTokens, u.TotalTokens, u.CachedTokens, u.CacheReadTokens, u.CacheCreationTokens} {
			if value < 0 {
				return fmt.Errorf("request %d has negative tokens", i)
			}
		}
		for _, value := range []*int64{request.PromptTokens, request.CacheCreation_5MTokens, request.CacheCreation_1HTokens} {
			if value != nil && *value < 0 {
				return fmt.Errorf("request %d has negative billing tokens", i)
			}
		}
		sum.Add(u)
	}
	if s.RequestCoverage == session.RequestCoverageComplete && (len(requests) == 0 || s.Usage == nil || sum != domainUsage(s.Usage)) {
		return fmt.Errorf("complete request usage must match session usage")
	}
	if len(requests) > 0 && s.ProjectionVersion < 14 {
		return fmt.Errorf("request usage requires projection version 14 or later")
	}
	return nil
}

func replaceSessionRequests(ctx context.Context, tx pgx.Tx, id string, requests []*prosav1.RequestUsage) error {
	if _, err := tx.Exec(ctx, `DELETE FROM session_requests WHERE session_id = $1`, id); err != nil {
		return fmt.Errorf("clear session requests: %w", err)
	}
	rows := make([][]any, len(requests))
	for i, request := range requests {
		payload, err := json.Marshal(domainRequest(request))
		if err != nil {
			return fmt.Errorf("encode request %d: %w", i, err)
		}
		rows[i] = []any{id, i, payload}
	}
	if len(rows) > 0 {
		if _, err := tx.CopyFrom(ctx, pgx.Identifier{"session_requests"}, []string{"session_id", "ordinal", "payload"}, pgx.CopyFromRows(rows)); err != nil {
			return fmt.Errorf("copy session requests: %w", err)
		}
	}
	return nil
}

func loadRequestFacts(ctx context.Context, pool *pgxpool.Pool, sessions []session.Session) error {
	const batchSize = 500
	for start := 0; start < len(sessions); start += batchSize {
		batch := sessions[start:min(start+batchSize, len(sessions))]
		ids := make([]string, len(batch))
		byID := make(map[string]int, len(batch))
		for i := range batch {
			ids[i] = batch[i].ID
			byID[batch[i].ID] = i
		}
		rows, err := pool.Query(ctx, `SELECT s.id, s.request_coverage, s.projection_version, r.payload
			FROM sessions s LEFT JOIN session_requests r ON r.session_id = s.id
			WHERE s.id = ANY($1) ORDER BY s.id, r.ordinal`, ids)
		if err != nil {
			return fmt.Errorf("load request facts: %w", err)
		}
		for rows.Next() {
			var id, coverage string
			var version int
			var payload []byte
			if err := rows.Scan(&id, &coverage, &version, &payload); err != nil {
				rows.Close()
				return fmt.Errorf("scan request facts: %w", err)
			}
			s := &batch[byID[id]]
			s.RequestCoverage, s.ProjectionVersion = coverage, version
			if payload != nil {
				var request session.RequestUsage
				if err := json.Unmarshal(payload, &request); err != nil {
					rows.Close()
					return fmt.Errorf("decode request facts: %w", err)
				}
				s.Requests = append(s.Requests, request)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return fmt.Errorf("read request facts: %w", err)
		}
	}
	return nil
}

func attachSessionCosts(ctx context.Context, pool *pgxpool.Pool, list []*prosav1.Session) error {
	facts := make([]session.Session, len(list))
	for i, s := range list {
		facts[i] = domainSession(s)
	}
	if err := loadRequestFacts(ctx, pool, facts); err != nil {
		return err
	}
	for i, s := range list {
		cost := pricing.SessionCost(facts[i])
		s.ProjectionVersion = int32(facts[i].ProjectionVersion)
		s.RequestCoverage = facts[i].RequestCoverage
		s.Cost = &prosav1.CostSummary{Usd: cost.USD, Status: cost.Status, PricedTokens: cost.PricedTokens, UnpricedTokens: cost.UnpricedTokens}
	}
	return nil
}
