package handlers

import (
	"context"
	"errors"
	"fmt"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/server/auth"
)

func (h *SessionsHandler) Get(ctx context.Context, req *connect.Request[prosav1.GetRequest]) (*connect.Response[prosav1.GetResponse], error) {
	callerDevice, isDevice := auth.DeviceFromContext(ctx)
	if !isDevice && !auth.IsOwner(ctx) {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing device or owner context"))
	}
	if req.Msg.Id == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, missingFields("id"))
	}
	row := h.Pool.QueryRow(ctx, `
		SELECT s.id, s.agent, s.device_id, s.project_path, s.project_remote, s.project_marker,
		       s.started_at, s.last_activity_at, s.first_prompt, s.model,
		       s.raw_uri, s.raw_hash, s.raw_size,
		       s.parent_session_id, s.profile,
		       su.session_id, su.total_tokens, su.input_tokens, su.output_tokens,
		       su.cached_tokens, su.cache_read_tokens, su.cache_creation_tokens
		FROM sessions s
		LEFT JOIN session_usage su ON su.session_id = s.id
		WHERE s.id = $1
	`, req.Msg.Id)
	s, err := scanSessionRow(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no session %s", req.Msg.Id))
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if isDevice && !auth.IsOwner(ctx) && s.DeviceId != callerDevice {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("session belongs to another device"))
	}

	turns, err := selectTurns(ctx, h.Pool, req.Msg.Id)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	tools, err := selectTools(ctx, h.Pool, req.Msg.Id)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&prosav1.GetResponse{Session: s, Turns: turns, Tools: tools}), nil
}

func (h *SessionsHandler) Manifest(ctx context.Context, req *connect.Request[prosav1.ManifestRequest]) (*connect.Response[prosav1.ManifestResponse], error) {
	deviceID, ok := auth.DeviceFromContext(ctx)
	if !ok {
		// Manifest is a device-scoped reconcile primitive; owner callers
		// (panel) have no meaningful device to scope to.
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing device context"))
	}
	limit := req.Msg.Limit
	if limit <= 0 {
		limit = 1000
	}
	if limit > 5000 {
		limit = 5000
	}

	rows, err := h.Pool.Query(
		ctx, `
		SELECT s.id,
		       COALESCE(ss.last_hash, ''),
		       COALESCE(ss.last_synced_at, to_timestamp(0)),
		       COALESCE(ss.projection_version, 0)
		FROM sessions s
		LEFT JOIN sync_state ss ON ss.session_id = s.id
		WHERE s.device_id = $1 AND s.id > $2
		ORDER BY s.id ASC
		LIMIT $3
	`, deviceID, req.Msg.AfterId, limit,
	)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("manifest query: %w", err))
	}
	defer rows.Close()

	out := &prosav1.ManifestResponse{}
	for rows.Next() {
		var (
			id, hash string
			synced   time.Time
			version  int32
		)
		if err := rows.Scan(&id, &hash, &synced, &version); err != nil {
			return nil, connect.NewError(connect.CodeInternal, err)
		}
		out.Entries = append(out.Entries, &prosav1.ManifestEntry{
			Id:                id,
			RawHash:           hash,
			LastSyncedAt:      timestamppb.New(synced),
			ProjectionVersion: version,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	// next_after_id is the last id on this page only when the page filled
	// to limit; if the caller got fewer rows, they've reached the end.
	if int32(len(out.Entries)) == limit && len(out.Entries) > 0 {
		out.NextAfterId = out.Entries[len(out.Entries)-1].Id
	}
	return connect.NewResponse(out), nil
}

// ListChildren returns every session whose parent_session_id matches
// the request id, ordered started_at ASC so the panel can render them
// in spawn order. Owner callers see all children; device callers only
// see children belonging to their device (so cross-device leakage stays
// closed even when a parent is shared across machines).
func (h *SessionsHandler) ListChildren(ctx context.Context, req *connect.Request[prosav1.ListChildrenRequest]) (*connect.Response[prosav1.ListChildrenResponse], error) {
	callerDevice, isDevice := auth.DeviceFromContext(ctx)
	if !isDevice && !auth.IsOwner(ctx) {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing device or owner context"))
	}
	if req.Msg.ParentId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, missingFields("parent_id"))
	}

	conds := []string{"s.parent_session_id = $1"}
	args := []any{req.Msg.ParentId}
	if isDevice && !auth.IsOwner(ctx) {
		conds = append(conds, "s.device_id = $2")
		args = append(args, callerDevice)
	}

	q := fmt.Sprintf(`
		SELECT s.id, s.agent, s.device_id, s.project_path, s.project_remote, s.project_marker,
		       s.started_at, s.last_activity_at, s.first_prompt, s.model,
		       s.raw_uri, s.raw_hash, s.raw_size,
		       s.parent_session_id, s.profile,
		       su.session_id, su.total_tokens, su.input_tokens, su.output_tokens,
		       su.cached_tokens, su.cache_read_tokens, su.cache_creation_tokens
		FROM sessions s
		LEFT JOIN session_usage su ON su.session_id = s.id
		WHERE %s
		ORDER BY s.started_at ASC
	`, joinAnd(conds))

	rows, err := h.Pool.Query(ctx, q, args...)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	defer rows.Close()

	out := &prosav1.ListChildrenResponse{}
	for rows.Next() {
		s, err := scanSessionRow(rows)
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, err)
		}
		out.Sessions = append(out.Sessions, s)
	}
	return connect.NewResponse(out), rows.Err()
}

func selectTurns(ctx context.Context, pool *pgxpool.Pool, sessionID string) ([]*prosav1.Turn, error) {
	rows, err := pool.Query(
		ctx,
		`SELECT role, content, ts, kind, tool_name FROM turns WHERE session_id = $1 ORDER BY ts ASC, id ASC`,
		sessionID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*prosav1.Turn
	for rows.Next() {
		var (
			role, content, kind string
			ts                  time.Time
			toolName            *string
		)
		if err := rows.Scan(&role, &content, &ts, &kind, &toolName); err != nil {
			return nil, err
		}
		turn := &prosav1.Turn{
			Role:    role,
			Content: content,
			Ts:      timestamppb.New(ts),
			Kind:    kind,
		}
		if toolName != nil {
			turn.ToolName = *toolName
		}
		out = append(out, turn)
	}
	return out, rows.Err()
}

func selectTools(ctx context.Context, pool *pgxpool.Pool, sessionID string) ([]*prosav1.ToolUsage, error) {
	rows, err := pool.Query(
		ctx,
		`SELECT name, count FROM session_tools WHERE session_id = $1 ORDER BY count DESC, name ASC`,
		sessionID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*prosav1.ToolUsage
	for rows.Next() {
		var (
			name  string
			count int32
		)
		if err := rows.Scan(&name, &count); err != nil {
			return nil, err
		}
		out = append(out, &prosav1.ToolUsage{Name: name, Count: count})
	}
	return out, rows.Err()
}
