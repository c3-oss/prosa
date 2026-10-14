package handlers

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5/pgxpool"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/pricing"
	"github.com/c3-oss/prosa/pkg/session"
)

func runPricedUsage(ctx context.Context, pool *pgxpool.Pool, msg *prosav1.GetReportRequest) (*connect.Response[prosav1.GetReportResponse], error) {
	whereSQL, args, err := buildWhere(ctx, msg)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	rows, err := pool.Query(ctx, `SELECT s.id, s.agent, s.device_id, s.profile, s.model,
		s.started_at, s.last_activity_at, s.parent_session_id,
		COALESCE(NULLIF(d.friendly_name, ''), s.device_id), su.session_id,
		COALESCE(su.total_tokens, 0), COALESCE(su.input_tokens, 0), COALESCE(su.output_tokens, 0),
		COALESCE(su.cached_tokens, 0), COALESCE(su.cache_read_tokens, 0), COALESCE(su.cache_creation_tokens, 0)
		FROM sessions s LEFT JOIN devices d ON d.id = s.device_id
		LEFT JOIN session_usage su ON su.session_id = s.id `+whereSQL+` ORDER BY s.id`, args...)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("usage sessions: %w", err))
	}
	var sessions []session.Session
	deviceNames := map[string]string{}
	for rows.Next() {
		var s session.Session
		var deviceName string
		var usageID *string
		var usage session.TokenUsage
		if err := rows.Scan(&s.ID, &s.Agent, &s.DeviceID, &s.Profile, &s.Model, &s.StartedAt, &s.LastActivityAt, &s.ParentSessionID,
			&deviceName, &usageID, &usage.TotalTokens, &usage.InputTokens, &usage.OutputTokens, &usage.CachedTokens, &usage.CacheReadTokens, &usage.CacheCreationTokens); err != nil {
			rows.Close()
			return nil, connect.NewError(connect.CodeInternal, err)
		}
		if usageID != nil {
			s.Usage = &usage
		}
		deviceNames[s.ID] = deviceName
		sessions = append(sessions, s)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if err := loadRequestFacts(ctx, pool, sessions); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(foldPricedUsage(msg.Report, sessions, deviceNames)), nil
}

type pricedUsageGroup struct {
	labels   []string
	sessions map[string]bool
	measured map[string]bool
	usage    session.TokenUsage
	cost     session.CostSummary
	last     time.Time
}

func foldPricedUsage(report string, sessions []session.Session, devices map[string]string) *prosav1.GetReportResponse {
	groups := map[string]*pricedUsageGroup{}
	for _, s := range sessions {
		units := pricing.UsageCosts(s)
		if len(units) == 0 {
			model := "(none)"
			if s.Model != nil && *s.Model != "" {
				model = *s.Model
			}
			units = []pricing.UsageCost{{Model: model, Cost: session.CostSummary{Status: session.CostUnavailable}}}
		}
		for _, unit := range units {
			model := unit.Model
			if model == "" {
				model = "(none)"
			}
			day := s.StartedAt.UTC().Format("2006-01-02")
			labels := []string{s.Agent}
			switch report {
			case "usage_by_model":
				labels = []string{model}
			case "usage_by_day":
				labels = []string{day, model}
			case "subagent_usage_by_day":
				kind := "direct"
				if s.ParentSessionID != nil && *s.ParentSessionID != "" {
					kind = "subagent"
				}
				labels = []string{day, kind, model}
			case "profile_usage":
				labels = []string{day, devices[s.ID], s.Agent, s.Profile, model}
			}
			key := strings.Join(labels, "\x00")
			g := groups[key]
			if g == nil {
				g = &pricedUsageGroup{labels: labels, sessions: map[string]bool{}, measured: map[string]bool{}}
				groups[key] = g
				g.cost = unit.Cost
			} else {
				g.cost = pricing.CombineCosts(g.cost, unit.Cost)
			}
			g.sessions[s.ID] = true
			if s.Usage != nil || len(s.Requests) > 0 {
				g.measured[s.ID] = true
			}
			g.usage.Add(unit.Usage)
			if s.LastActivityAt.After(g.last) {
				g.last = s.LastActivityAt
			}
		}
	}
	list := make([]*pricedUsageGroup, 0, len(groups))
	for _, g := range groups {
		list = append(list, g)
	}
	sort.Slice(list, func(i, j int) bool {
		if report == "usage" || report == "usage_by_model" {
			if len(list[i].sessions) != len(list[j].sessions) {
				return len(list[i].sessions) > len(list[j].sessions)
			}
		}
		return strings.Join(list[i].labels, "\x00") < strings.Join(list[j].labels, "\x00")
	})
	headers := []string{"AGENT", "SESSIONS", "MEASURED", "TOTAL", "INPUT", "OUTPUT", "CACHED", "EST_COST_USD"}
	switch report {
	case "usage_by_model":
		headers = []string{"MODEL", "SESSIONS", "TOTAL", "INPUT", "OUTPUT", "EST_COST_USD"}
	case "usage_by_day":
		headers = []string{"DAY", "MODEL", "SESSIONS", "MEASURED", "TOTAL", "INPUT", "OUTPUT", "CACHED", "CACHE_READ", "CACHE_CREATION", "EST_COST_USD"}
	case "subagent_usage_by_day":
		headers = []string{"DAY", "KIND", "MODEL", "SESSIONS", "MEASURED", "TOTAL", "INPUT", "OUTPUT", "CACHED", "CACHE_READ", "CACHE_CREATION", "EST_COST_USD"}
	case "profile_usage":
		headers = []string{"DAY", "DEVICE", "AGENT", "PROFILE", "MODEL", "SESSIONS", "MEASURED", "TOTAL", "INPUT", "OUTPUT", "CACHED", "CACHE_READ", "CACHE_CREATION", "LAST_ACTIVITY", "EST_COST_USD"}
	}
	headers = append(headers, "COST_STATUS", "PRICED_TOKENS", "UNPRICED_TOKENS")
	out := &prosav1.GetReportResponse{Headers: headers}
	for _, g := range list {
		values := append([]string{}, g.labels...)
		values = append(values, strconv.Itoa(len(g.sessions)))
		if report != "usage_by_model" {
			values = append(values, strconv.Itoa(len(g.measured)))
		}
		values = append(values, strconv.FormatInt(g.usage.TotalTokens, 10), strconv.FormatInt(g.usage.InputTokens, 10), strconv.FormatInt(g.usage.OutputTokens, 10))
		if report != "usage_by_model" {
			values = append(values, strconv.FormatInt(g.usage.CachedTokens, 10))
		}
		if report == "usage_by_day" || report == "subagent_usage_by_day" || report == "profile_usage" {
			values = append(values, strconv.FormatInt(g.usage.CacheReadTokens, 10), strconv.FormatInt(g.usage.CacheCreationTokens, 10))
		}
		if report == "profile_usage" {
			values = append(values, g.last.UTC().Format("2006-01-02 15:04"))
		}
		usd := ""
		if g.cost.USD != nil {
			usd = fmt.Sprintf("%.4f", *g.cost.USD)
		}
		values = append(values, usd, g.cost.Status, strconv.FormatInt(g.cost.PricedTokens, 10), strconv.FormatInt(g.cost.UnpricedTokens, 10))
		out.Rows = append(out.Rows, &prosav1.AnalyticsRow{Values: values})
	}
	return out
}
