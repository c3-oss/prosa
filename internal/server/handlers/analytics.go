package handlers

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5/pgxpool"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/pricing"
	"github.com/c3-oss/prosa/internal/server/auth"
	"github.com/c3-oss/prosa/pkg/session"
)

// AnalyticsHandler implements AnalyticsService against Postgres. The
// CLI-facing reports mirror internal/store/analytics.go (which targets
// SQLite), rewritten with $N placeholders and tsvector FTS in place of
// FTS5. The insights reports feed the panel only, with no SQLite mirror.
type AnalyticsHandler struct {
	prosav1connect.UnimplementedAnalyticsServiceHandler
	Pool *pgxpool.Pool
}

func NewAnalyticsHandler(pool *pgxpool.Pool) *AnalyticsHandler {
	return &AnalyticsHandler{Pool: pool}
}

// errorTriggers mirrors the heuristic used by the CLI's analytics
// errors report: any of these terms in an assistant turn flags the
// session.
const errorTriggers = "error | exception | traceback | panic | fatal"

// GetReport dispatches by report name. Device callers are auto-scoped
// to their own sessions; owner callers (panel) see every device.
func (h *AnalyticsHandler) GetReport(ctx context.Context, req *connect.Request[prosav1.GetReportRequest]) (*connect.Response[prosav1.GetReportResponse], error) {
	if _, isDevice := auth.DeviceFromContext(ctx); !isDevice && !auth.IsOwner(ctx) {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing device or owner context"))
	}
	if req.Msg.Since == nil || req.Msg.Until == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, missingFields("since", "until"))
	}
	switch req.Msg.Report {
	case "sessions":
		return runReport(ctx, h.Pool, req.Msg, querySessions, []string{"AGENT", "SESSIONS", "TURNS"})
	case "tools":
		return runReport(ctx, h.Pool, req.Msg, queryTools, []string{"TOOL", "USES", "SESSIONS"})
	case "models":
		return runReport(ctx, h.Pool, req.Msg, queryModels, []string{"MODEL", "SESSIONS"})
	case "projects":
		return runReport(ctx, h.Pool, req.Msg, queryProjects, []string{"PROJECT", "AGENT", "SESSIONS"})
	case "profiles":
		return runReport(ctx, h.Pool, req.Msg, queryProfiles, []string{"DEVICE", "AGENT", "PROFILE", "SESSIONS"})
	case "errors":
		return runReport(ctx, h.Pool, req.Msg, queryErrors, []string{"STARTED", "AGENT", "PROJECT", "SESSION"})
	case "heatmap":
		return runHeatmap(ctx, h.Pool, req.Msg)
	case "usage":
		return runUsage(ctx, h.Pool, req.Msg)
	case "hours":
		return runReport(ctx, h.Pool, req.Msg, queryHours, []string{"HOUR", "SESSIONS"})
	case "errors_by_model":
		return runReport(ctx, h.Pool, req.Msg, queryErrorsByModel, []string{"MODEL", "SESSIONS"})
	case "usage_by_model":
		return runUsageByModel(ctx, h.Pool, req.Msg)
	case "usage_by_day":
		return runReport(ctx, h.Pool, req.Msg, queryUsageByDay,
			[]string{"DAY", "MODEL", "SESSIONS", "MEASURED", "TOTAL", "INPUT", "OUTPUT", "CACHED", "CACHE_READ", "CACHE_CREATION"})
	case "punchcard":
		return runReport(ctx, h.Pool, req.Msg, queryPunchcard, []string{"DOW", "HOUR", "SESSIONS"})
	case "durations":
		return runReport(ctx, h.Pool, req.Msg, queryDurations, []string{"BUCKET", "SESSIONS"})
	case "duration_stats":
		return runReport(ctx, h.Pool, req.Msg, queryDurationStats, []string{"MEDIAN_S", "P90_S", "AVG_S", "MAX_S"})
	case "subagents":
		return runReport(ctx, h.Pool, req.Msg, querySubagents, []string{"AGENT", "PARENTS", "CHILDREN", "MAX_FANOUT"})
	default:
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("unknown report %q (want sessions|tools|models|projects|profiles|errors|heatmap|usage|hours|usage_by_model|errors_by_model|usage_by_day|punchcard|durations|duration_stats|subagents)", req.Msg.Report))
	}
}

// querySpec is the contract every report obeys: build a (query, args)
// pair given a filter, where `whereSQL` is already-formatted (`WHERE
// a AND b AND ...`) and `args` carries the values in $1..$N order.
type querySpec func(whereSQL string, args []any) (string, []any)

func runReport(
	ctx context.Context,
	pool *pgxpool.Pool,
	msg *prosav1.GetReportRequest,
	spec querySpec,
	headers []string,
) (*connect.Response[prosav1.GetReportResponse], error) {
	whereSQL, args, err := buildWhere(ctx, msg)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	q, args := spec(whereSQL, args)
	rows, err := pool.Query(ctx, q, args...)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("analytics query: %w", err))
	}
	defer rows.Close()

	out := &prosav1.GetReportResponse{Headers: headers}
	for rows.Next() {
		desc := rows.FieldDescriptions()
		holders := make([]any, len(desc))
		strs := make([]*string, len(desc))
		for i := range desc {
			strs[i] = new(string)
			holders[i] = strs[i]
		}
		if err := rows.Scan(holders...); err != nil {
			return nil, connect.NewError(connect.CodeInternal, err)
		}
		values := make([]string, len(strs))
		for i, p := range strs {
			values[i] = *p
		}
		out.Rows = append(out.Rows, &prosav1.AnalyticsRow{Values: values})
	}
	if err := rows.Err(); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(out), nil
}

// buildWhere produces the WHERE clause shared by every report. Honors
// time bounds (required), agent / device_name / project filters, and
// owner vs device scoping (device callers see only their sessions).
func buildWhere(ctx context.Context, msg *prosav1.GetReportRequest) (string, []any, error) {
	conds := []string{"s.started_at >= $1", "s.started_at <= $2"}
	args := []any{tsToTime(msg.Since), tsToTime(msg.Until)}
	idx := 3
	addEq := func(col, val string) {
		conds = append(conds, fmt.Sprintf("s.%s = $%d", col, idx))
		args = append(args, val)
		idx++
	}
	if msg.ProjectRemote != "" {
		addEq("project_remote", msg.ProjectRemote)
	}
	if msg.ProjectMarker != "" {
		addEq("project_marker", msg.ProjectMarker)
	}
	if msg.ProjectPath != "" {
		addEq("project_path", msg.ProjectPath)
	}
	if msg.ProjectMatch != "" {
		conds = append(conds, fmt.Sprintf("s.project_path LIKE $%d", idx))
		args = append(args, "%"+msg.ProjectMatch+"%")
		idx++
	}
	if msg.Agent != "" {
		addEq("agent", msg.Agent)
	}
	switch {
	case len(msg.DeviceNames) > 0:
		conds = append(conds, fmt.Sprintf("s.device_id IN (SELECT id FROM devices WHERE friendly_name = ANY($%d))", idx))
		args = append(args, msg.DeviceNames)
		idx++
	case msg.DeviceName != "":
		conds = append(conds, fmt.Sprintf("s.device_id IN (SELECT id FROM devices WHERE friendly_name = $%d)", idx))
		args = append(args, msg.DeviceName)
		idx++
	}
	if caller, isDevice := auth.DeviceFromContext(ctx); isDevice && !auth.IsOwner(ctx) {
		conds = append(conds, fmt.Sprintf("s.device_id = $%d", idx))
		args = append(args, caller)
		idx++
	}
	return "WHERE " + strings.Join(conds, " AND "), args, nil
}

func runHeatmap(
	ctx context.Context,
	pool *pgxpool.Pool,
	msg *prosav1.GetReportRequest,
) (*connect.Response[prosav1.GetReportResponse], error) {
	whereSQL, args, err := buildWhere(ctx, msg)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	q := `
		SELECT to_char((s.started_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
		       s.agent,
		       COUNT(*)::bigint AS sessions
		FROM sessions s
		` + whereSQL + `
		GROUP BY day, s.agent
		ORDER BY day ASC, s.agent ASC`
	rows, err := pool.Query(ctx, q, args...)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("analytics heatmap: %w", err))
	}
	defer rows.Close()

	type agentCount struct {
		agent string
		count int64
	}
	perDay := map[string][]agentCount{}
	for rows.Next() {
		var (
			day, agent string
			n          int64
		)
		if err := rows.Scan(&day, &agent, &n); err != nil {
			return nil, connect.NewError(connect.CodeInternal, err)
		}
		perDay[day] = append(perDay[day], agentCount{agent: agent, count: n})
	}
	if err := rows.Err(); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	// Emit one row per (day, agent). Days with zero sessions still get a
	// single (day, "", 0) row so the panel can render an empty cell with
	// the correct calendar position.
	out := &prosav1.GetReportResponse{Headers: []string{"DATE", "AGENT", "SESSIONS"}}
	for d := dayStart(tsToTime(msg.Since)); !d.After(dayStart(tsToTime(msg.Until))); d = d.AddDate(0, 0, 1) {
		key := d.Format("2006-01-02")
		entries := perDay[key]
		if len(entries) == 0 {
			out.Rows = append(out.Rows, &prosav1.AnalyticsRow{
				Values: []string{key, "", "0"},
			})
			continue
		}
		for _, e := range entries {
			out.Rows = append(out.Rows, &prosav1.AnalyticsRow{
				Values: []string{key, e.agent, fmt.Sprintf("%d", e.count)},
			})
		}
	}
	return connect.NewResponse(out), nil
}

func runUsage(
	ctx context.Context,
	pool *pgxpool.Pool,
	msg *prosav1.GetReportRequest,
) (*connect.Response[prosav1.GetReportResponse], error) {
	whereSQL, args, err := buildWhere(ctx, msg)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	q := `
		SELECT s.agent,
		       COALESCE(s.model, '') AS model,
		       COUNT(DISTINCT s.id)::bigint AS sessions,
		       COUNT(su.session_id)::bigint AS measured,
		       COALESCE(SUM(su.total_tokens), 0)::bigint AS total_tokens,
		       COALESCE(SUM(su.input_tokens), 0)::bigint AS input_tokens,
		       COALESCE(SUM(su.output_tokens), 0)::bigint AS output_tokens,
		       COALESCE(SUM(su.cached_tokens), 0)::bigint AS cached_tokens,
		       COALESCE(SUM(su.cache_read_tokens), 0)::bigint AS cache_read_tokens,
		       COALESCE(SUM(su.cache_creation_tokens), 0)::bigint AS cache_creation_tokens
		FROM sessions s
		LEFT JOIN session_usage su ON su.session_id = s.id
		` + whereSQL + `
		GROUP BY s.agent, model
		ORDER BY COUNT(DISTINCT s.id) DESC`
	rows, err := pool.Query(ctx, q, args...)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("analytics usage: %w", err))
	}
	defer rows.Close()

	type usageAgg struct {
		agent    string
		sessions int64
		measured int64
		usage    session.TokenUsage
		cost     float64
		priced   bool
	}
	byAgent := map[string]*usageAgg{}
	for rows.Next() {
		var (
			agent, model string
			sessionsN    int64
			measured     int64
			u            session.TokenUsage
		)
		if err := rows.Scan(
			&agent, &model, &sessionsN, &measured,
			&u.TotalTokens, &u.InputTokens, &u.OutputTokens, &u.CachedTokens,
			&u.CacheReadTokens, &u.CacheCreationTokens,
		); err != nil {
			return nil, connect.NewError(connect.CodeInternal, err)
		}
		agg := byAgent[agent]
		if agg == nil {
			agg = &usageAgg{agent: agent}
			byAgent[agent] = agg
		}
		agg.sessions += sessionsN
		agg.measured += measured
		agg.usage.TotalTokens += u.TotalTokens
		agg.usage.InputTokens += u.InputTokens
		agg.usage.OutputTokens += u.OutputTokens
		agg.usage.CachedTokens += u.CachedTokens
		agg.usage.CacheReadTokens += u.CacheReadTokens
		agg.usage.CacheCreationTokens += u.CacheCreationTokens
		if measured > 0 {
			if c, ok := pricing.CostUSD(model, u); ok {
				agg.cost += c
				agg.priced = true
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	aggs := make([]*usageAgg, 0, len(byAgent))
	for _, agg := range byAgent {
		aggs = append(aggs, agg)
	}
	sort.Slice(aggs, func(i, j int) bool {
		if aggs[i].sessions == aggs[j].sessions {
			return aggs[i].agent < aggs[j].agent
		}
		return aggs[i].sessions > aggs[j].sessions
	})

	out := &prosav1.GetReportResponse{Headers: []string{
		"AGENT", "SESSIONS", "MEASURED", "TOTAL", "INPUT", "OUTPUT", "CACHED", "EST_COST_USD",
	}}
	for _, agg := range aggs {
		cost := ""
		if agg.priced {
			cost = fmt.Sprintf("%.4f", agg.cost)
		}
		out.Rows = append(out.Rows, &prosav1.AnalyticsRow{Values: []string{
			agg.agent,
			fmt.Sprintf("%d", agg.sessions),
			fmt.Sprintf("%d", agg.measured),
			fmt.Sprintf("%d", agg.usage.TotalTokens),
			fmt.Sprintf("%d", agg.usage.InputTokens),
			fmt.Sprintf("%d", agg.usage.OutputTokens),
			fmt.Sprintf("%d", agg.usage.CachedTokens),
			cost,
		}})
	}
	return connect.NewResponse(out), nil
}

// runUsageByModel groups by model instead of agent; each group shares one
// model so cost is a straight pricing.CostUSD over the summed usage.
func runUsageByModel(
	ctx context.Context,
	pool *pgxpool.Pool,
	msg *prosav1.GetReportRequest,
) (*connect.Response[prosav1.GetReportResponse], error) {
	whereSQL, args, err := buildWhere(ctx, msg)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	q := `
		SELECT COALESCE(s.model, '(none)') AS model,
		       COUNT(DISTINCT s.id)::bigint AS sessions,
		       COUNT(su.session_id)::bigint AS measured,
		       COALESCE(SUM(su.total_tokens), 0)::bigint AS total_tokens,
		       COALESCE(SUM(su.input_tokens), 0)::bigint AS input_tokens,
		       COALESCE(SUM(su.output_tokens), 0)::bigint AS output_tokens,
		       COALESCE(SUM(su.cached_tokens), 0)::bigint AS cached_tokens,
		       COALESCE(SUM(su.cache_read_tokens), 0)::bigint AS cache_read_tokens,
		       COALESCE(SUM(su.cache_creation_tokens), 0)::bigint AS cache_creation_tokens
		FROM sessions s
		LEFT JOIN session_usage su ON su.session_id = s.id
		` + whereSQL + `
		GROUP BY model
		ORDER BY COUNT(DISTINCT s.id) DESC`
	rows, err := pool.Query(ctx, q, args...)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("analytics usage_by_model: %w", err))
	}
	defer rows.Close()

	out := &prosav1.GetReportResponse{Headers: []string{
		"MODEL", "SESSIONS", "TOTAL", "INPUT", "OUTPUT", "EST_COST_USD",
	}}
	for rows.Next() {
		var (
			model     string
			sessionsN int64
			measured  int64
			u         session.TokenUsage
		)
		if err := rows.Scan(
			&model, &sessionsN, &measured,
			&u.TotalTokens, &u.InputTokens, &u.OutputTokens, &u.CachedTokens,
			&u.CacheReadTokens, &u.CacheCreationTokens,
		); err != nil {
			return nil, connect.NewError(connect.CodeInternal, err)
		}
		cost := ""
		if measured > 0 {
			if c, ok := pricing.CostUSD(model, u); ok {
				cost = fmt.Sprintf("%.4f", c)
			}
		}
		out.Rows = append(out.Rows, &prosav1.AnalyticsRow{Values: []string{
			model,
			fmt.Sprintf("%d", sessionsN),
			fmt.Sprintf("%d", u.TotalTokens),
			fmt.Sprintf("%d", u.InputTokens),
			fmt.Sprintf("%d", u.OutputTokens),
			cost,
		}})
	}
	if err := rows.Err(); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(out), nil
}

func dayStart(t time.Time) time.Time {
	y, m, d := t.UTC().Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

func querySessions(whereSQL string, args []any) (string, []any) {
	q := `
		SELECT s.agent,
		       COUNT(DISTINCT s.id)::text AS sessions,
		       COUNT(t.id)::text          AS turns
		FROM sessions s
		LEFT JOIN turns t ON t.session_id = s.id
		` + whereSQL + `
		GROUP BY s.agent
		ORDER BY COUNT(DISTINCT s.id) DESC`
	return q, args
}

func queryTools(whereSQL string, args []any) (string, []any) {
	q := `
		SELECT st.name,
		       SUM(st.count)::text       AS uses,
		       COUNT(DISTINCT s.id)::text AS sessions
		FROM session_tools st
		JOIN sessions s ON s.id = st.session_id
		` + whereSQL + `
		GROUP BY st.name
		ORDER BY SUM(st.count) DESC
		LIMIT 20`
	return q, args
}

func queryModels(whereSQL string, args []any) (string, []any) {
	q := `
		SELECT COALESCE(s.model, '(none)') AS model,
		       COUNT(*)::text              AS sessions
		FROM sessions s
		` + whereSQL + `
		GROUP BY model
		ORDER BY COUNT(*) DESC`
	return q, args
}

func queryProjects(whereSQL string, args []any) (string, []any) {
	q := `
		SELECT COALESCE(s.project_remote, s.project_marker, s.project_path, '(unscoped)') AS project,
		       s.agent,
		       COUNT(*)::text AS sessions
		FROM sessions s
		` + whereSQL + `
		GROUP BY project, s.agent
		ORDER BY COUNT(*) DESC`
	return q, args
}

// queryProfiles breaks sessions down by device, agent, and profile.
func queryProfiles(whereSQL string, args []any) (string, []any) {
	q := `
		SELECT COALESCE(NULLIF(d.friendly_name, ''), s.device_id) AS device,
		       s.agent,
		       s.profile,
		       COUNT(*)::text AS sessions
		FROM sessions s
		LEFT JOIN devices d ON d.id = s.device_id
		` + whereSQL + `
		GROUP BY device, s.agent, s.profile
		ORDER BY device ASC, s.agent ASC, s.profile ASC`
	return q, args
}

func queryErrors(whereSQL string, args []any) (string, []any) {
	// Postgres FTS equivalent of the SQLite FTS5 heuristic. The trigger
	// terms are OR'd via to_tsquery's `|` operator.
	args = append(args, errorTriggers)
	tsParam := fmt.Sprintf("$%d", len(args))
	q := `
		SELECT to_char(s.started_at, 'YYYY-MM-DD HH24:MI'),
		       s.agent,
		       COALESCE(s.project_remote, s.project_marker, s.project_path, '(unscoped)') AS project,
		       s.id
		FROM sessions s
		JOIN turns t ON t.session_id = s.id
		` + whereSQL + ` AND t.role = 'assistant'
		             AND t.content_tsv @@ to_tsquery('simple', ` + tsParam + `)
		GROUP BY s.id
		ORDER BY s.started_at DESC
		LIMIT 30`
	return q, args
}

// queryHours buckets sessions by UTC start-hour ("00".."23"); the panel
// rotates to local time for display.
func queryHours(whereSQL string, args []any) (string, []any) {
	q := `
		SELECT to_char(s.started_at AT TIME ZONE 'UTC', 'HH24') AS hour,
		       COUNT(*)::text                                    AS sessions
		FROM sessions s
		` + whereSQL + `
		GROUP BY hour
		ORDER BY hour ASC`
	return q, args
}

// queryErrorsByModel groups the FTS error heuristic by model. Uncapped so
// the row sum is the true flagged-session count for an error-rate indicator.
func queryErrorsByModel(whereSQL string, args []any) (string, []any) {
	args = append(args, errorTriggers)
	tsParam := fmt.Sprintf("$%d", len(args))
	q := `
		SELECT COALESCE(s.model, '(none)') AS model,
		       COUNT(DISTINCT s.id)::text   AS sessions
		FROM sessions s
		JOIN turns t ON t.session_id = s.id
		` + whereSQL + ` AND t.role = 'assistant'
		             AND t.content_tsv @@ to_tsquery('simple', ` + tsParam + `)
		GROUP BY model
		ORDER BY COUNT(DISTINCT s.id) DESC`
	return q, args
}

// queryUsageByDay returns raw token sums per (UTC day, model). No zero-fill:
// the panel fills calendar gaps and prices each row, so rows stay bounded by active days.
func queryUsageByDay(whereSQL string, args []any) (string, []any) {
	q := `
		SELECT to_char((s.started_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
		       COALESCE(s.model, '(none)') AS model,
		       COUNT(DISTINCT s.id)::text  AS sessions,
		       COUNT(su.session_id)::text  AS measured,
		       COALESCE(SUM(su.total_tokens), 0)::text          AS total_tokens,
		       COALESCE(SUM(su.input_tokens), 0)::text          AS input_tokens,
		       COALESCE(SUM(su.output_tokens), 0)::text         AS output_tokens,
		       COALESCE(SUM(su.cached_tokens), 0)::text         AS cached_tokens,
		       COALESCE(SUM(su.cache_read_tokens), 0)::text     AS cache_read_tokens,
		       COALESCE(SUM(su.cache_creation_tokens), 0)::text AS cache_creation_tokens
		FROM sessions s
		LEFT JOIN session_usage su ON su.session_id = s.id
		` + whereSQL + `
		GROUP BY day, model
		ORDER BY day ASC, model ASC`
	return q, args
}

// queryPunchcard buckets sessions by (UTC weekday, UTC start-hour).
// EXTRACT(DOW) is 0=Sunday, matching Go's time.Weekday; the panel rotates to local time.
func queryPunchcard(whereSQL string, args []any) (string, []any) {
	q := `
		SELECT EXTRACT(DOW FROM s.started_at AT TIME ZONE 'UTC')::int::text AS dow,
		       to_char(s.started_at AT TIME ZONE 'UTC', 'HH24')             AS hour,
		       COUNT(*)::text                                               AS sessions
		FROM sessions s
		` + whereSQL + `
		GROUP BY dow, hour
		ORDER BY dow ASC, hour ASC`
	return q, args
}

// durationSeconds is the wall-clock span of a session (clamped at zero for
// clock skew), shared by queryDurations and queryDurationStats.
const durationSeconds = `
	SELECT GREATEST(EXTRACT(EPOCH FROM (s.last_activity_at - s.started_at)), 0) AS d
	FROM sessions s
	`

// queryDurations histograms session durations into fixed buckets. No ORDER BY:
// the panel emits buckets in canonical order and looks counts up by name.
func queryDurations(whereSQL string, args []any) (string, []any) {
	q := `
		SELECT CASE
		         WHEN d < 300  THEN '<5m'
		         WHEN d < 900  THEN '5-15m'
		         WHEN d < 1800 THEN '15-30m'
		         WHEN d < 3600 THEN '30-60m'
		         WHEN d < 7200 THEN '1-2h'
		         ELSE '>2h'
		       END AS bucket,
		       COUNT(*)::text AS sessions
		FROM (` + durationSeconds + whereSQL + `) x
		GROUP BY bucket`
	return q, args
}

// queryDurationStats returns one row of duration percentiles in whole seconds.
// COALESCE keeps an empty window at zeros instead of NULLs.
func queryDurationStats(whereSQL string, args []any) (string, []any) {
	q := `
		SELECT COALESCE(ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY d))::bigint, 0)::text AS median_s,
		       COALESCE(ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY d))::bigint, 0)::text AS p90_s,
		       COALESCE(ROUND(AVG(d))::bigint, 0)::text AS avg_s,
		       COALESCE(ROUND(MAX(d))::bigint, 0)::text AS max_s
		FROM (` + durationSeconds + whereSQL + `) x`
	return q, args
}

// querySubagents aggregates subagent fan-out per parent agent. Filters apply
// to the children, but grouping is by the parent's agent (the spawning session).
func querySubagents(whereSQL string, args []any) (string, []any) {
	q := `
		SELECT agent,
		       COUNT(*)::text      AS parents,
		       SUM(children)::text AS children,
		       MAX(children)::text AS max_fanout
		FROM (
		  SELECT p.agent AS agent, s.parent_session_id, COUNT(*) AS children
		  FROM sessions s
		  JOIN sessions p ON p.id = s.parent_session_id
		  ` + whereSQL + ` AND s.parent_session_id IS NOT NULL
		  GROUP BY p.agent, s.parent_session_id
		) x
		GROUP BY agent
		ORDER BY SUM(children) DESC, agent ASC`
	return q, args
}
