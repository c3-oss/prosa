package handlers

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5/pgxpool"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/server/auth"
)

// AnalyticsHandler implements AnalyticsService against Postgres. The
// queries mirror internal/store/analytics.go (which targets SQLite),
// rewritten with $N placeholders and tsvector FTS in place of FTS5.
type AnalyticsHandler struct {
	prosav1connect.UnimplementedAnalyticsServiceHandler
	Pool *pgxpool.Pool
}

// NewAnalyticsHandler wires the handler.
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
	case "errors":
		return runReport(ctx, h.Pool, req.Msg, queryErrors, []string{"STARTED", "AGENT", "PROJECT", "SESSION"})
	default:
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("unknown report %q (want sessions|tools|models|projects|errors)", req.Msg.Report))
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
	if msg.Agent != "" {
		addEq("agent", msg.Agent)
	}
	if msg.DeviceName != "" {
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
		ORDER BY COUNT(*) DESC
		LIMIT 30`
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
