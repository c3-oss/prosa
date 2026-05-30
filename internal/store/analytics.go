package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
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
