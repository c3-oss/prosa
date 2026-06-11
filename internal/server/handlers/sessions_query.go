package handlers

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/server/auth"
)

func (h *SessionsHandler) List(ctx context.Context, req *connect.Request[prosav1.ListRequest]) (*connect.Response[prosav1.ListResponse], error) {
	callerDevice, isDevice := auth.DeviceFromContext(ctx)
	if !isDevice && !auth.IsOwner(ctx) {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing device or owner context"))
	}
	if req.Msg.Since == nil || req.Msg.Until == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, missingFields("since", "until"))
	}
	sortBy, err := normalizeListSort(req.Msg.SortBy)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	sortDir, err := normalizeSortDir(req.Msg.SortDir, sortBy)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	conds := []string{"s.started_at >= $1", "s.started_at <= $2"}
	args := []any{tsToTime(req.Msg.Since), tsToTime(req.Msg.Until)}
	idx := 3
	if isDevice && !auth.IsOwner(ctx) {
		conds = append(conds, fmt.Sprintf("s.device_id = $%d", idx))
		args = append(args, callerDevice)
		idx++
	}
	addEq := func(col, val string) {
		conds = append(conds, fmt.Sprintf("s.%s = $%d", col, idx))
		args = append(args, val)
		idx++
	}
	if req.Msg.ProjectPath != "" {
		addEq("project_path", req.Msg.ProjectPath)
	}
	switch {
	case len(req.Msg.ProjectMatches) > 0:
		// Multi-select: a session matches if any value is a substring of any
		// of the three project columns. LIKE ANY(array) keeps it one param.
		// This is the convenience filter; callers with full identity should
		// use project_path / project_remote / project_marker so indexes apply.
		patterns := make([]string, len(req.Msg.ProjectMatches))
		for i, pm := range req.Msg.ProjectMatches {
			patterns[i] = "%" + pm + "%"
		}
		conds = append(conds, fmt.Sprintf(
			"(s.project_path LIKE ANY($%d) OR s.project_remote LIKE ANY($%d) OR s.project_marker LIKE ANY($%d))",
			idx, idx, idx,
		))
		args = append(args, patterns)
		idx++
	case req.Msg.ProjectMatch != "":
		// Convenience substring filter. Keep exact project fields separate so
		// callers that know the full identity can use indexed equality.
		conds = append(conds, fmt.Sprintf(
			"(s.project_path LIKE $%d OR s.project_remote LIKE $%d OR s.project_marker LIKE $%d)",
			idx, idx+1, idx+2,
		))
		pattern := "%" + req.Msg.ProjectMatch + "%"
		args = append(args, pattern, pattern, pattern)
		idx += 3
	}
	if req.Msg.ProjectRemote != "" {
		addEq("project_remote", req.Msg.ProjectRemote)
	}
	if req.Msg.ProjectMarker != "" {
		addEq("project_marker", req.Msg.ProjectMarker)
	}
	switch {
	case len(req.Msg.Agents) > 0:
		conds = append(conds, fmt.Sprintf("s.agent = ANY($%d)", idx))
		args = append(args, req.Msg.Agents)
		idx++
	case req.Msg.Agent != "":
		addEq("agent", req.Msg.Agent)
	}
	switch {
	case len(req.Msg.Profiles) > 0:
		conds = append(conds, fmt.Sprintf("s.profile = ANY($%d)", idx))
		args = append(args, req.Msg.Profiles)
		idx++
	case req.Msg.Profile != "":
		addEq("profile", req.Msg.Profile)
	}
	join := ""
	switch {
	case len(req.Msg.DeviceNames) > 0:
		join = " JOIN devices d ON d.id = s.device_id"
		conds = append(conds, fmt.Sprintf("d.friendly_name = ANY($%d)", idx))
		args = append(args, req.Msg.DeviceNames)
		idx++
	case req.Msg.DeviceName != "":
		join = " JOIN devices d ON d.id = s.device_id"
		conds = append(conds, fmt.Sprintf("d.friendly_name = $%d", idx))
		args = append(args, req.Msg.DeviceName)
		idx++
	}
	if req.Msg.TopLevelOnly {
		conds = append(conds, "s.parent_session_id IS NULL")
	}
	// FTS branch: when query is set, JOIN turns and filter on the
	// tsvector. Reuse the same Postgres operator Search uses for parity.
	ftsQuery := strings.TrimSpace(req.Msg.Query)
	ftsJoin := ""
	if ftsQuery != "" {
		ftsJoin = " JOIN turns ft ON ft.session_id = s.id"
		conds = append(conds, fmt.Sprintf("ft.content_tsv @@ plainto_tsquery('simple', $%d)", idx))
		args = append(args, ftsQuery)
		idx++
	}
	limit := req.Msg.Limit
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	offset := req.Msg.Offset
	if offset < 0 {
		offset = 0
	}

	// total_count uses the same WHERE/JOIN as the page query so paging
	// math is correct under all filter combinations. Distinct on s.id
	// because the FTS JOIN can otherwise multiply rows per session.
	totalQ := fmt.Sprintf(`
		SELECT COUNT(DISTINCT s.id)
		FROM sessions s%s%s
		WHERE %s
	`, join, ftsJoin, joinAnd(conds))
	totalArgs := append([]any{}, args...)

	var (
		orderBy     string
		selectExtra string
		groupBy     string
	)
	if ftsQuery != "" {
		// rank by FTS, falling back to started_at for determinism. GROUP BY
		// all scalar columns we SELECT so MAX(ts_rank) lets us collapse the
		// turns-join multiplicity into one row per session.
		selectExtra = ",\n		       MAX(ts_rank(ft.content_tsv, plainto_tsquery('simple', $" + fmt.Sprint(idx) + "))) AS _rank"
		args = append(args, ftsQuery)
		idx++
		groupBy = `
		GROUP BY s.id, s.agent, s.device_id, s.project_path, s.project_remote, s.project_marker,
		         s.started_at, s.last_activity_at, s.first_prompt, s.model,
		         s.raw_uri, s.raw_hash, s.raw_size, s.parent_session_id, s.profile,
		         su.session_id, su.total_tokens, su.input_tokens, su.output_tokens,
		         su.cached_tokens, su.cache_read_tokens, su.cache_creation_tokens`
		orderBy = "_rank DESC, s.started_at DESC"
	} else if sortBy == "total_tokens" {
		orderBy = fmt.Sprintf("su.total_tokens %s NULLS LAST, s.started_at DESC", sortDir)
	} else if sortBy == "agent" {
		orderBy = fmt.Sprintf("s.agent %s, s.started_at DESC", sortDir)
	} else if sortBy == "project" {
		orderBy = fmt.Sprintf(
			"COALESCE(NULLIF(s.project_marker, ''), NULLIF(s.project_remote, ''), NULLIF(s.project_path, '')) %s NULLS LAST, s.started_at DESC",
			sortDir,
		)
	} else if sortBy == "device" {
		if join == "" {
			join = " LEFT JOIN devices d ON d.id = s.device_id"
		}
		orderBy = fmt.Sprintf("COALESCE(NULLIF(d.friendly_name, ''), s.device_id) %s, s.started_at DESC", sortDir)
	} else {
		orderBy = fmt.Sprintf("s.started_at %s", sortDir)
	}
	q := fmt.Sprintf(`
		SELECT s.id, s.agent, s.device_id, s.project_path, s.project_remote, s.project_marker,
		       s.started_at, s.last_activity_at, s.first_prompt, s.model,
		       s.raw_uri, s.raw_hash, s.raw_size,
		       s.parent_session_id, s.profile,
		       su.session_id, su.total_tokens, su.input_tokens, su.output_tokens,
		       su.cached_tokens, su.cache_read_tokens, su.cache_creation_tokens%s
		FROM sessions s
		LEFT JOIN session_usage su ON su.session_id = s.id%s%s
		WHERE %s%s
		ORDER BY %s
		LIMIT $%d OFFSET $%d
	`, selectExtra, join, ftsJoin, joinAnd(conds), groupBy, orderBy, idx, idx+1)
	args = append(args, limit, offset)

	out := &prosav1.ListResponse{}

	rows, err := h.Pool.Query(ctx, q, args...)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	for rows.Next() {
		s, err := scanSessionListRow(rows, ftsQuery != "")
		if err != nil {
			rows.Close()
			return nil, connect.NewError(connect.CodeInternal, err)
		}
		out.Sessions = append(out.Sessions, s)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	var total int64
	if err := h.Pool.QueryRow(ctx, totalQ, totalArgs...).Scan(&total); err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("count: %w", err))
	}
	out.TotalCount = total

	return connect.NewResponse(out), nil
}

func normalizeListSort(v string) (string, error) {
	switch v {
	case "", "started_at":
		return "started_at", nil
	case "total_tokens":
		return "total_tokens", nil
	case "agent", "project", "device":
		return v, nil
	default:
		return "", fmt.Errorf("invalid sort_by %q (allowed: started_at, total_tokens, agent, project, device)", v)
	}
}

func defaultListSortDir(sortBy string) string {
	switch sortBy {
	case "agent", "project", "device":
		return "ASC"
	default:
		return "DESC"
	}
}

func normalizeSortDir(raw, sortBy string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "":
		return defaultListSortDir(sortBy), nil
	case "asc":
		return "ASC", nil
	case "desc":
		return "DESC", nil
	default:
		return "", fmt.Errorf("invalid sort_dir %q (allowed: asc, desc)", raw)
	}
}

// scanSessionListRow extends scanSessionRow with the optional FTS rank
// column. The rank value is discarded after scan — we only need it for
// ORDER BY.
func scanSessionListRow(r scannable, withRank bool) (*prosav1.Session, error) {
	if !withRank {
		return scanSessionRow(r)
	}
	var (
		s                                                             prosav1.Session
		projectPath, projectRemote, projectMarker, firstPrompt, model *string
		parentSessionID                                               *string
		usageSession                                                  *string
		totalTokens, inputTokens, outputTokens                        *int64
		cachedTokens, cacheReadTokens, cacheCreationTokens            *int64
		started, lastAct                                              time.Time
		rank                                                          float64
	)
	if err := r.Scan(
		&s.Id, &s.Agent, &s.DeviceId,
		&projectPath, &projectRemote, &projectMarker,
		&started, &lastAct,
		&firstPrompt, &model,
		&s.RawUri, &s.RawHash, &s.RawSize,
		&parentSessionID, &s.Profile,
		&usageSession, &totalTokens, &inputTokens, &outputTokens,
		&cachedTokens, &cacheReadTokens, &cacheCreationTokens,
		&rank,
	); err != nil {
		return nil, err
	}
	if projectPath != nil {
		s.ProjectPath = *projectPath
	}
	if projectRemote != nil {
		s.ProjectRemote = *projectRemote
	}
	if projectMarker != nil {
		s.ProjectMarker = *projectMarker
	}
	if firstPrompt != nil {
		s.FirstPrompt = *firstPrompt
	}
	if model != nil {
		s.Model = *model
	}
	if parentSessionID != nil {
		s.ParentSessionId = *parentSessionID
	}
	s.StartedAt = timestamppb.New(started)
	s.LastActivityAt = timestamppb.New(lastAct)
	if usageSession != nil {
		s.Usage = &prosav1.TokenUsage{
			TotalTokens:         derefInt64(totalTokens),
			InputTokens:         derefInt64(inputTokens),
			OutputTokens:        derefInt64(outputTokens),
			CachedTokens:        derefInt64(cachedTokens),
			CacheReadTokens:     derefInt64(cacheReadTokens),
			CacheCreationTokens: derefInt64(cacheCreationTokens),
		}
	}
	return &s, nil
}

func (h *SessionsHandler) Search(ctx context.Context, req *connect.Request[prosav1.SearchRequest]) (*connect.Response[prosav1.SearchResponse], error) {
	callerDevice, isDevice := auth.DeviceFromContext(ctx)
	if !isDevice && !auth.IsOwner(ctx) {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing device or owner context"))
	}
	if req.Msg.Query == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, missingFields("query"))
	}
	if req.Msg.Since == nil || req.Msg.Until == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, missingFields("since", "until"))
	}
	limit := req.Msg.Limit
	if limit <= 0 || limit > 200 {
		limit = 20
	}

	conds := []string{
		"s.started_at >= $1",
		"s.started_at <= $2",
		"t.content_tsv @@ plainto_tsquery('simple', $3)",
	}
	args := []any{tsToTime(req.Msg.Since), tsToTime(req.Msg.Until), req.Msg.Query}
	idx := 4
	if isDevice && !auth.IsOwner(ctx) {
		conds = append(conds, fmt.Sprintf("s.device_id = $%d", idx))
		args = append(args, callerDevice)
		idx++
	}
	addEq := func(col, val string) {
		conds = append(conds, fmt.Sprintf("s.%s = $%d", col, idx))
		args = append(args, val)
		idx++
	}
	if req.Msg.ProjectRemote != "" {
		addEq("project_remote", req.Msg.ProjectRemote)
	}
	if req.Msg.ProjectMarker != "" {
		addEq("project_marker", req.Msg.ProjectMarker)
	}
	if req.Msg.Agent != "" {
		addEq("agent", req.Msg.Agent)
	}
	if req.Msg.Profile != "" {
		addEq("profile", req.Msg.Profile)
	}
	join := ""
	switch {
	case len(req.Msg.DeviceNames) > 0:
		join = " JOIN devices d ON d.id = s.device_id"
		conds = append(conds, fmt.Sprintf("d.friendly_name = ANY($%d)", idx))
		args = append(args, req.Msg.DeviceNames)
		idx++
	case req.Msg.DeviceName != "":
		join = " JOIN devices d ON d.id = s.device_id"
		conds = append(conds, fmt.Sprintf("d.friendly_name = $%d", idx))
		args = append(args, req.Msg.DeviceName)
		idx++
	}

	q := fmt.Sprintf(`
		SELECT DISTINCT ON (s.id)
		       s.id, s.agent, s.device_id, s.project_path, s.project_remote, s.project_marker,
		       s.started_at, s.last_activity_at, s.first_prompt, s.model,
		       s.raw_uri, s.raw_hash, s.raw_size,
		       s.parent_session_id, s.profile,
		       su.session_id, su.total_tokens, su.input_tokens, su.output_tokens,
		       su.cached_tokens, su.cache_read_tokens, su.cache_creation_tokens,
		       t.id, t.ts, t.role, t.kind, t.tool_name,
		       ts_headline('simple', t.content,
		                   plainto_tsquery('simple', $3),
		                   'StartSel=«, StopSel=», MaxFragments=1, MaxWords=16, MinWords=3, ShortWord=2') AS snippet,
		       ts_rank(t.content_tsv, plainto_tsquery('simple', $3)) AS rank
		FROM sessions s
		JOIN turns t ON t.session_id = s.id
		LEFT JOIN session_usage su ON su.session_id = s.id%s
		WHERE %s
		ORDER BY s.id, ts_rank(t.content_tsv, plainto_tsquery('simple', $3)) DESC
		LIMIT $%d
	`, join, joinAnd(conds), idx)
	args = append(args, limit)

	rows, err := h.Pool.Query(ctx, q, args...)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	defer rows.Close()

	out := &prosav1.SearchResponse{}
	for rows.Next() {
		hit, err := scanSearchHit(rows)
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, err)
		}
		out.Hits = append(out.Hits, hit)
	}
	return connect.NewResponse(out), rows.Err()
}

// Manifest returns the next page of (id, raw_hash, last_synced_at) for
// the authenticated device's sessions, ordered by id ASC. Clients call
// it before pushing to detect sessions that exist locally but never
// reached the server. Scoped to the caller's device — the manifest of
// device A never leaks to device B.
//
// The LEFT JOIN on sync_state means a sessions row with no sync_state
// (e.g. a future import-without-push or an S3-only restore) still appears,
// with an empty hash so the client re-pushes it — self-healing rather than
