package store

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/c3-oss/prosa/internal/pricing"
	"github.com/c3-oss/prosa/pkg/session"
)

// AnalyticsRow is the row emitted by every Analytics<X> query — a
// generic ordered slice of values keyed by Headers. The renderer (or
// the --json emitter) prints them as is.
type AnalyticsRow struct {
	Values []any
}

// AnalyticsResult bundles headers + rows so callers can render
// uniformly without per-report dispatch.
type AnalyticsResult struct {
	Headers []string
	Rows    []AnalyticsRow
}

// AnalyticsSessions: COUNT(*), total turns, avg duration, by agent.
func (s *Store) AnalyticsSessions(ctx context.Context, f SessionFilter) (AnalyticsResult, error) {
	q, args := analyticsQuery(`
		SELECT s.agent,
		       COUNT(DISTINCT s.id) AS sessions,
		       COUNT(t.id)          AS turns
		FROM sessions s
		LEFT JOIN turns t ON t.session_id = s.id
	`, ` GROUP BY s.agent ORDER BY sessions DESC`, f)
	return scanAnalytics(ctx, s.db, q, args, []string{"AGENT", "SESSIONS", "TURNS"})
}

// AnalyticsTools: SUM(session_tools.count) by tool name, top 20.
func (s *Store) AnalyticsTools(ctx context.Context, f SessionFilter) (AnalyticsResult, error) {
	q, args := analyticsQuery(`
		SELECT st.name,
		       SUM(st.count) AS uses,
		       COUNT(DISTINCT s.id) AS sessions
		FROM session_tools st
		JOIN sessions s ON s.id = st.session_id
	`, ` GROUP BY st.name ORDER BY uses DESC LIMIT 20`, f)
	return scanAnalytics(ctx, s.db, q, args, []string{"TOOL", "USES", "SESSIONS"})
}

// AnalyticsModels: COUNT(*) by sessions.model, sorted desc.
func (s *Store) AnalyticsModels(ctx context.Context, f SessionFilter) (AnalyticsResult, error) {
	q, args := analyticsQuery(`
		SELECT COALESCE(s.model, '(none)') AS model,
		       COUNT(*)                    AS sessions
		FROM sessions s
	`, ` GROUP BY model ORDER BY sessions DESC`, f)
	return scanAnalytics(ctx, s.db, q, args, []string{"MODEL", "SESSIONS"})
}

// AnalyticsProjects: identity-aware COUNT by best-available project key.
func (s *Store) AnalyticsProjects(ctx context.Context, f SessionFilter) (AnalyticsResult, error) {
	q, args := analyticsQuery(`
		SELECT COALESCE(s.project_remote, s.project_marker, s.project_path, '(unscoped)') AS project,
		       s.agent,
		       COUNT(*) AS sessions
		FROM sessions s
	`, ` GROUP BY project, s.agent ORDER BY sessions DESC LIMIT 30`, f)
	return scanAnalytics(ctx, s.db, q, args, []string{"PROJECT", "AGENT", "SESSIONS"})
}

// AnalyticsHeatmap emits one row per (day, agent) over the selected window,
// matching the server's heatmap report shape exactly (DATE, AGENT,
// SESSIONS). Zero-session days still get a single (day, "", 0) row so
// callers can render a stable GitHub-style contribution graph with correct
// calendar positions. The CLI rolls these per-agent rows up to per-day
// totals for its table; the panel uses the per-agent breakdown.
func (s *Store) AnalyticsHeatmap(ctx context.Context, f SessionFilter) (AnalyticsResult, error) {
	q, args := analyticsQuery(`
		SELECT substr(s.started_at, 1, 10) AS day,
		       s.agent,
		       COUNT(*) AS sessions
		FROM sessions s
	`, ` GROUP BY day, s.agent ORDER BY day ASC, s.agent ASC`, f)

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return AnalyticsResult{}, fmt.Errorf("analytics heatmap: %w", err)
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
			return AnalyticsResult{}, err
		}
		perDay[day] = append(perDay[day], agentCount{agent: agent, count: n})
	}
	if err := rows.Err(); err != nil {
		return AnalyticsResult{}, err
	}

	start := dayStart(f.Since)
	end := dayStart(f.Until)
	out := AnalyticsResult{Headers: []string{"DATE", "AGENT", "SESSIONS"}}
	for d := start; !d.After(end); d = d.AddDate(0, 0, 1) {
		key := d.Format("2006-01-02")
		entries := perDay[key]
		if len(entries) == 0 {
			out.Rows = append(out.Rows, AnalyticsRow{Values: []any{key, "", "0"}})
			continue
		}
		for _, e := range entries {
			out.Rows = append(out.Rows, AnalyticsRow{Values: []any{key, e.agent, fmt.Sprintf("%d", e.count)}})
		}
	}
	return out, nil
}

// AnalyticsUsage aggregates measured token consumption by agent and adds an
// estimated USD cost where the embedded pricing table recognizes the model.
func (s *Store) AnalyticsUsage(ctx context.Context, f SessionFilter) (AnalyticsResult, error) {
	q, args := analyticsQuery(`
		SELECT s.agent,
		       COALESCE(s.model, '') AS model,
		       COUNT(DISTINCT s.id) AS sessions,
		       COUNT(su.session_id) AS measured,
		       COALESCE(SUM(su.total_tokens), 0) AS total_tokens,
		       COALESCE(SUM(su.input_tokens), 0) AS input_tokens,
		       COALESCE(SUM(su.output_tokens), 0) AS output_tokens,
		       COALESCE(SUM(su.cached_tokens), 0) AS cached_tokens,
		       COALESCE(SUM(su.cache_read_tokens), 0) AS cache_read_tokens,
		       COALESCE(SUM(su.cache_creation_tokens), 0) AS cache_creation_tokens
		FROM sessions s
		LEFT JOIN session_usage su ON su.session_id = s.id
	`, ` GROUP BY s.agent, model ORDER BY sessions DESC`, f)

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return AnalyticsResult{}, fmt.Errorf("analytics usage: %w", err)
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
			return AnalyticsResult{}, err
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
		return AnalyticsResult{}, err
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

	out := AnalyticsResult{Headers: []string{
		"AGENT", "SESSIONS", "MEASURED", "TOTAL", "INPUT", "OUTPUT", "CACHED", "EST_COST_USD",
	}}
	for _, agg := range aggs {
		cost := ""
		if agg.priced {
			cost = fmt.Sprintf("%.4f", agg.cost)
		}
		out.Rows = append(out.Rows, AnalyticsRow{Values: []any{
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
	return out, nil
}

// errorTriggers are the FTS5 terms used by AnalyticsErrors. Documented in
// the cobra Long help so users know the heuristic is content-based.
const errorTriggers = "error OR exception OR traceback OR panic OR fatal"

// AnalyticsErrors: sessions whose assistant turns match common error
// signals. Heuristic — flagged in --help.
func (s *Store) AnalyticsErrors(ctx context.Context, f SessionFilter) (AnalyticsResult, error) {
	q, args := analyticsQuery(`
		SELECT s.started_at,
		       s.agent,
		       COALESCE(s.project_remote, s.project_marker, s.project_path, '(unscoped)') AS project,
		       s.id
		FROM sessions s
		JOIN turns t ON t.session_id = s.id
		JOIN turns_fts f ON f.rowid = t.id
	`, ` WHERE_AND t.role = 'assistant' AND turns_fts MATCH '`+errorTriggers+`' GROUP BY s.id ORDER BY s.started_at DESC LIMIT 30`, f)
	return scanAnalytics(ctx, s.db, q, args, []string{"STARTED", "AGENT", "PROJECT", "SESSION"})
}

// AnalyticsHours buckets sessions by their UTC start-hour ("00".."23") for
// a "when do I work" view. The hour is read straight off the RFC3339Nano
// started_at text — substr is cheaper than a date parse and mirrors the
// substr(started_at, 1, 10) day idiom AnalyticsHeatmap uses. The report is
// canonically UTC (like the heatmap); callers wanting a local-time view
// rotate the buckets after the fact.
func (s *Store) AnalyticsHours(ctx context.Context, f SessionFilter) (AnalyticsResult, error) {
	q, args := analyticsQuery(`
		SELECT substr(s.started_at, 12, 2) AS hour,
		       COUNT(*)                     AS sessions
		FROM sessions s
	`, ` GROUP BY hour ORDER BY hour ASC`, f)
	return scanAnalytics(ctx, s.db, q, args, []string{"HOUR", "SESSIONS"})
}

// AnalyticsErrorsByModel counts the sessions flagged by the errorTriggers
// FTS heuristic, grouped by model. Unlike AnalyticsErrors (a recent-rows
// list capped at 30) this is the full aggregate, so the sum across rows is
// the true flagged-session count an error-rate indicator needs. Heuristic,
// same caveat as AnalyticsErrors.
func (s *Store) AnalyticsErrorsByModel(ctx context.Context, f SessionFilter) (AnalyticsResult, error) {
	q, args := analyticsQuery(`
		SELECT COALESCE(s.model, '(none)') AS model,
		       COUNT(DISTINCT s.id)        AS sessions
		FROM sessions s
		JOIN turns t ON t.session_id = s.id
		JOIN turns_fts f ON f.rowid = t.id
	`, ` WHERE_AND t.role = 'assistant' AND turns_fts MATCH '`+errorTriggers+`' GROUP BY model ORDER BY sessions DESC`, f)
	return scanAnalytics(ctx, s.db, q, args, []string{"MODEL", "SESSIONS"})
}

// AnalyticsUsageByModel mirrors AnalyticsUsage but groups by model instead
// of agent, so the panel can rank token spend per model and draw a cost
// donut. Each group shares one model, so cost is a straight
// pricing.CostUSD over the summed usage; models the table doesn't
// recognize emit an empty EST_COST_USD.
func (s *Store) AnalyticsUsageByModel(ctx context.Context, f SessionFilter) (AnalyticsResult, error) {
	q, args := analyticsQuery(`
		SELECT COALESCE(s.model, '(none)') AS model,
		       COUNT(DISTINCT s.id) AS sessions,
		       COUNT(su.session_id) AS measured,
		       COALESCE(SUM(su.total_tokens), 0) AS total_tokens,
		       COALESCE(SUM(su.input_tokens), 0) AS input_tokens,
		       COALESCE(SUM(su.output_tokens), 0) AS output_tokens,
		       COALESCE(SUM(su.cached_tokens), 0) AS cached_tokens,
		       COALESCE(SUM(su.cache_read_tokens), 0) AS cache_read_tokens,
		       COALESCE(SUM(su.cache_creation_tokens), 0) AS cache_creation_tokens
		FROM sessions s
		LEFT JOIN session_usage su ON su.session_id = s.id
	`, ` GROUP BY model ORDER BY sessions DESC`, f)

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return AnalyticsResult{}, fmt.Errorf("analytics usage_by_model: %w", err)
	}
	defer rows.Close()

	out := AnalyticsResult{Headers: []string{
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
			return AnalyticsResult{}, err
		}
		cost := ""
		if measured > 0 {
			if c, ok := pricing.CostUSD(model, u); ok {
				cost = fmt.Sprintf("%.4f", c)
			}
		}
		out.Rows = append(out.Rows, AnalyticsRow{Values: []any{
			model,
			fmt.Sprintf("%d", sessionsN),
			fmt.Sprintf("%d", u.TotalTokens),
			fmt.Sprintf("%d", u.InputTokens),
			fmt.Sprintf("%d", u.OutputTokens),
			cost,
		}})
	}
	return out, rows.Err()
}

// analyticsQuery glues the SELECT skeleton to the SessionFilter's
// generic conds. The marker `WHERE_AND` is substituted with either
// `WHERE` (no SessionFilter conds added) or `WHERE a AND b AND` so the
// caller can append further AND-clauses safely.
//
// SessionFilter.Since/Until are mandatory (cut-2 invariant). Agent /
// DeviceName / ProjectExact / ProjectMatch / ProjectRemote /
// ProjectMarker are all honored.
func analyticsQuery(selectSQL, tail string, f SessionFilter) (string, []any) {
	conds := []string{"s.started_at >= ?", "s.started_at <= ?"}
	args := []any{formatTime(f.Since), formatTime(f.Until)}

	if f.ProjectExact != nil {
		conds = append(conds, "s.project_path = ?")
		args = append(args, *f.ProjectExact)
	}
	if f.ProjectMatch != nil {
		conds = append(conds, "s.project_path LIKE ?")
		args = append(args, "%"+*f.ProjectMatch+"%")
	}
	if f.ProjectRemote != nil {
		conds = append(conds, "s.project_remote = ?")
		args = append(args, *f.ProjectRemote)
	}
	if f.ProjectMarker != nil {
		conds = append(conds, "s.project_marker = ?")
		args = append(args, *f.ProjectMarker)
	}
	if f.Agent != nil {
		conds = append(conds, "s.agent = ?")
		args = append(args, *f.Agent)
	}
	join := ""
	if f.DeviceName != nil {
		join = " JOIN devices d ON d.id = s.device_id"
		conds = append(conds, "d.friendly_name = ?")
		args = append(args, *f.DeviceName)
	}
	where := "WHERE " + strings.Join(conds, " AND ")
	whereAnd := where + " AND"
	body := selectSQL + join
	if strings.Contains(tail, "WHERE_AND") {
		body += " " + strings.Replace(tail, "WHERE_AND", whereAnd, 1)
	} else {
		body += " " + where + tail
	}
	return body, args
}

// scanAnalytics is the generic scanner. It uses sql.RawBytes to deal
// with mixed integer / string columns without per-report type knowledge.
func scanAnalytics(ctx context.Context, db *sql.DB, q string, args []any, headers []string) (AnalyticsResult, error) {
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return AnalyticsResult{}, fmt.Errorf("analytics query: %w", err)
	}
	defer func() { _ = rows.Close() }()

	colTypes, err := rows.ColumnTypes()
	if err != nil {
		return AnalyticsResult{}, err
	}
	out := AnalyticsResult{Headers: headers, Rows: nil}
	for rows.Next() {
		valPtrs := make([]any, len(colTypes))
		holders := make([]sql.NullString, len(colTypes))
		for i := range holders {
			valPtrs[i] = &holders[i]
		}
		if err := rows.Scan(valPtrs...); err != nil {
			return AnalyticsResult{}, err
		}
		values := make([]any, len(holders))
		for i, h := range holders {
			values[i] = nullOrString(h)
		}
		out.Rows = append(out.Rows, AnalyticsRow{Values: values})
	}
	return out, rows.Err()
}

func nullOrString(s sql.NullString) any {
	if !s.Valid {
		return ""
	}
	return s.String
}

func dayStart(t time.Time) time.Time {
	y, m, d := t.UTC().Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// FormatDuration is exposed for tests / renderers.
func FormatDuration(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%dmin", int(d.Minutes()))
	}
	h := int(d.Hours())
	m := int(d.Minutes()) - h*60
	return fmt.Sprintf("%dh%02d", h, m)
}
