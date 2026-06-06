package handlers

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/server/auth"
	"github.com/c3-oss/prosa/internal/server/storage"
	"github.com/c3-oss/prosa/pkg/session"
)

// SessionsHandler implements the SessionsService Connect interface.
type SessionsHandler struct {
	prosav1connect.UnimplementedSessionsServiceHandler
	Pool *pgxpool.Pool
	Obj  *storage.ObjectStore
}

// NewSessionsHandler wires the handler.
func NewSessionsHandler(pool *pgxpool.Pool, obj *storage.ObjectStore) *SessionsHandler {
	return &SessionsHandler{Pool: pool, Obj: obj}
}

// Push uploads one session: raw bytes land in S3 (idempotent on
// raw_hash) and metadata/turns/tools mirror into Postgres in a single
// transaction.
func (h *SessionsHandler) Push(ctx context.Context, req *connect.Request[prosav1.PushRequest]) (*connect.Response[prosav1.PushResponse], error) {
	deviceID, ok := auth.DeviceFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing device context"))
	}
	sess := req.Msg.Session
	if sess == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, missingFields("session"))
	}
	if sess.Id == "" || sess.RawHash == "" || sess.Agent == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, missingFields("session.id", "session.raw_hash", "session.agent"))
	}
	if err := validatePushedSessionID(sess.Id); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	if err := validatePushedAgent(sess.Agent); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}

	// Force the device_id to the authenticated caller; clients can't
	// impersonate another device by setting a different value on the
	// wire.
	sess.DeviceId = deviceID

	// Sessions with no token usage signal (e.g. cursor by design or
	// pre-token_count codex transcripts) intentionally arrive with
	// sess.Usage == nil. The client already classified them as
	// admissible (UsageStateUnknown); the server stores the row and
	// `replaceSessionUsage` below correctly omits a session_usage entry.
	// No early-return here.

	// Idempotency short-circuit: same hash as what sync_state already has.
	var (
		lastHash          string
		projectionVersion int
	)
	err := h.Pool.QueryRow(
		ctx,
		`SELECT last_hash, projection_version FROM sync_state WHERE session_id = $1`, sess.Id,
	).Scan(&lastHash, &projectionVersion)
	if err == nil && lastHash == sess.RawHash && projectionVersion >= session.ProjectionVersion {
		// Idempotent re-push is still a successful sync: bump last_sync so a
		// device that pushes then immediately resyncs doesn't look dormant
		// to the panel (which reads last_sync from DevicesService.List).
		if _, uerr := h.Pool.Exec(
			ctx,
			`UPDATE devices SET last_sync = $1 WHERE id = $2`, time.Now().UTC(), deviceID,
		); uerr != nil {
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("bump last_sync: %w", uerr))
		}
		return connect.NewResponse(&prosav1.PushResponse{Skipped: true}), nil
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("read sync_state: %w", err))
	}

	// Upload raw to S3.
	started := sess.StartedAt.AsTime().UTC()
	key := rawKey(deviceID, sess.Agent, sess.Id, started)

	// If the object already exists, it is referenced by a previously
	// committed sessions row; a metadata failure below must not delete it.
	// Only an object we newly create here can be orphaned, so only that one
	// is eligible for cleanup. When Stat itself fails we cannot tell, so we
	// fail safe toward "do not delete".
	objectIsNew := false
	if exists, statErr := h.Obj.Exists(ctx, key); statErr == nil {
		objectIsNew = !exists
	}

	uri, err := h.Obj.Put(ctx, key, bytes.NewReader(req.Msg.Raw), int64(len(req.Msg.Raw)))
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("upload raw: %w", err))
	}
	sess.RawUri = uri

	// The raw object is uploaded before the metadata tx commits. If any
	// metadata write fails the tx rolls back, but the object would stay in
	// the bucket forever (there is no GC path). Best-effort remove it on
	// the failure path, but only when we created it (see objectIsNew).
	committed := false
	defer func() {
		if committed || !objectIsNew {
			return
		}
		// ctx may already be cancelled (client hung up); use a detached,
		// time-bounded context so cleanup still runs.
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		if err := h.Obj.Remove(cleanupCtx, key); err != nil {
			slog.WarnContext(ctx, "push: orphaned raw object, best-effort cleanup failed",
				"key", key, "err", err)
		}
	}()

	// Mirror metadata + turns + tools in one tx.
	tx, err := h.Pool.Begin(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := upsertSession(ctx, tx, sess); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if err := replaceSessionUsage(ctx, tx, sess.Id, sess.Usage); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if err := replaceSessionTools(ctx, tx, sess.Id, req.Msg.Tools); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if err := replaceTurns(ctx, tx, sess.Id, req.Msg.Turns); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if err := recordSync(ctx, tx, sess.Id, sess.RawHash); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	// Bump last_sync on the device row.
	if _, err := tx.Exec(
		ctx,
		`UPDATE devices SET last_sync = $1 WHERE id = $2`, time.Now().UTC(), deviceID,
	); err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("bump last_sync: %w", err))
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	committed = true
	return connect.NewResponse(&prosav1.PushResponse{Skipped: false, RawUri: uri}), nil
}

func validatePushedSessionID(id string) error {
	if id == "" {
		return missingFields("session.id")
	}
	if err := session.ValidateID(id); err != nil {
		return fmt.Errorf("invalid session.id: %w", err)
	}
	return nil
}

func validatePushedAgent(agent string) error {
	switch agent {
	case "claude-code", "codex", "cursor", "gemini", "antigravity", "hermes":
		return nil
	case "":
		return missingFields("session.agent")
	default:
		return fmt.Errorf("invalid session.agent: %q is not supported", agent)
	}
}

// List returns sessions filtered by since/until + optional project /
// agent / device dimensions. Device callers are auto-scoped to their
// own device_id (cannot see other devices' rows); owner callers
// (panel) get a cross-device list and may further narrow via
// device_name. When req.Query is non-empty, results are restricted to
// sessions whose turns match the FTS query, ordered by ts_rank desc
// (sort_by is ignored). Offset/limit drive page-N navigation, and
// ListResponse.TotalCount reports the number of rows that match the
// same filters before paging.
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
		         s.raw_uri, s.raw_hash, s.raw_size, s.parent_session_id,
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
		       s.parent_session_id,
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

// normalizeListSort whitelists ListRequest.sort_by. Empty defaults to
// started_at. Anything outside the allowed set returns a client error.
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

// defaultListSortDir is the direction used when sort_dir is empty.
func defaultListSortDir(sortBy string) string {
	switch sortBy {
	case "agent", "project", "device":
		return "ASC"
	default:
		return "DESC"
	}
}

// normalizeSortDir whitelists ListRequest.sort_dir and returns the SQL
// keyword ASC or DESC for ORDER BY. Empty uses the column default.
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
		&parentSessionID,
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

// Get returns one session by id along with its turns and tools.
// Device callers may only fetch sessions belonging to their device;
// owner callers (panel) can read any session.
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
		       s.parent_session_id,
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

// Search runs the FTS query (tsvector + plainto_tsquery) against the
// turns table and returns one hit per matching session with the
// ts_headline-derived snippet. Device callers are auto-scoped to their
// own sessions; owner callers (panel) search across every device.
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
		       s.parent_session_id,
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
		SELECT s.id, ss.last_hash, ss.last_synced_at, ss.projection_version
		FROM sessions s
		JOIN sync_state ss ON ss.session_id = s.id
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
		       s.parent_session_id,
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

func joinAnd(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += " AND "
		}
		out += p
	}
	return out
}

// scanSessionRow scans the canonical session select columns into a
// proto. Works with both pgx.Row and pgx.Rows.
type scannable interface {
	Scan(dest ...any) error
}

func scanSessionRow(r scannable) (*prosav1.Session, error) {
	var (
		s                                                             prosav1.Session
		projectPath, projectRemote, projectMarker, firstPrompt, model *string
		parentSessionID                                               *string
		usageSession                                                  *string
		totalTokens, inputTokens, outputTokens                        *int64
		cachedTokens, cacheReadTokens, cacheCreationTokens            *int64
		started, lastAct                                              time.Time
	)
	if err := r.Scan(
		&s.Id, &s.Agent, &s.DeviceId,
		&projectPath, &projectRemote, &projectMarker,
		&started, &lastAct,
		&firstPrompt, &model,
		&s.RawUri, &s.RawHash, &s.RawSize,
		&parentSessionID,
		&usageSession, &totalTokens, &inputTokens, &outputTokens,
		&cachedTokens, &cacheReadTokens, &cacheCreationTokens,
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

func scanSearchHit(r scannable) (*prosav1.SearchHit, error) {
	var (
		s                                                             prosav1.Session
		projectPath, projectRemote, projectMarker, firstPrompt, model *string
		parentSessionID                                               *string
		usageSession                                                  *string
		totalTokens, inputTokens, outputTokens                        *int64
		cachedTokens, cacheReadTokens, cacheCreationTokens            *int64
		started, lastAct, turnTS                                      time.Time
		role, kind, snippet                                           string
		toolName                                                      *string
		turnID                                                        int64
		rank                                                          float64
	)
	if err := r.Scan(
		&s.Id, &s.Agent, &s.DeviceId,
		&projectPath, &projectRemote, &projectMarker,
		&started, &lastAct,
		&firstPrompt, &model,
		&s.RawUri, &s.RawHash, &s.RawSize,
		&parentSessionID,
		&usageSession, &totalTokens, &inputTokens, &outputTokens,
		&cachedTokens, &cacheReadTokens, &cacheCreationTokens,
		&turnID, &turnTS, &role, &kind, &toolName,
		&snippet, &rank,
	); err != nil {
		return nil, err
	}
	if parentSessionID != nil {
		s.ParentSessionId = *parentSessionID
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
	hit := &prosav1.SearchHit{
		Session:    &s,
		Snippet:    snippet,
		Role:       role,
		TurnId:     turnID,
		TurnTs:     timestamppb.New(turnTS),
		Kind:       kind,
		MatchField: "turn.content",
		Rank:       rank,
	}
	if toolName != nil {
		hit.ToolName = *toolName
	}
	return hit, nil
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

// rawKey computes the canonical S3 key. Mirrors paths.RawRoot semantics:
//
//	<device-id>/<agent>/<YYYY>/<MM>/<id>.<ext>
//
// The extension is derived from the agent name, since the wire shape
// doesn't carry it explicitly. Falls back to .bin for unknown agents.
func rawKey(deviceID, agent, sessionID string, started time.Time) string {
	if started.IsZero() {
		started = time.Now().UTC()
	}
	year := fmt.Sprintf("%04d", started.UTC().Year())
	month := fmt.Sprintf("%02d", started.UTC().Month())
	ext := extForAgent(agent)
	return path.Join(deviceID, agent, year, month, sessionID+ext)
}

func extForAgent(agent string) string {
	switch agent {
	case "claude-code", "codex":
		return ".jsonl"
	case "gemini":
		return ".json"
	case "cursor", "antigravity":
		return ".db"
	}
	return ".bin"
}

// upsertSession writes the session row, replacing every field on conflict.
func upsertSession(ctx context.Context, tx pgx.Tx, s *prosav1.Session) error {
	_, err := tx.Exec(
		ctx, `
		INSERT INTO sessions (
			id, agent, device_id, project_path, project_remote, project_marker,
			started_at, last_activity_at, first_prompt, model,
			raw_uri, raw_hash, raw_size, parent_session_id
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
		ON CONFLICT (id) DO UPDATE SET
			agent             = EXCLUDED.agent,
			device_id         = EXCLUDED.device_id,
			project_path      = EXCLUDED.project_path,
			project_remote    = EXCLUDED.project_remote,
			project_marker    = EXCLUDED.project_marker,
			started_at        = EXCLUDED.started_at,
			last_activity_at  = EXCLUDED.last_activity_at,
			first_prompt      = EXCLUDED.first_prompt,
			model             = EXCLUDED.model,
			raw_uri           = EXCLUDED.raw_uri,
			raw_hash          = EXCLUDED.raw_hash,
			raw_size          = EXCLUDED.raw_size,
			parent_session_id = EXCLUDED.parent_session_id
	`,
		s.Id, s.Agent, s.DeviceId,
		nullIfEmpty(s.ProjectPath), nullIfEmpty(s.ProjectRemote), nullIfEmpty(s.ProjectMarker),
		tsToTime(s.StartedAt), tsToTime(s.LastActivityAt),
		nullIfEmpty(s.FirstPrompt), nullIfEmpty(s.Model),
		s.RawUri, s.RawHash, s.RawSize, nullIfEmpty(s.ParentSessionId),
	)
	if err != nil {
		return fmt.Errorf("upsert session %s: %w", s.Id, err)
	}
	return nil
}

func replaceSessionTools(ctx context.Context, tx pgx.Tx, sessionID string, tools []*prosav1.ToolUsage) error {
	if _, err := tx.Exec(
		ctx,
		`DELETE FROM session_tools WHERE session_id = $1`, sessionID,
	); err != nil {
		return fmt.Errorf("clear session_tools: %w", err)
	}
	for _, t := range tools {
		if _, err := tx.Exec(
			ctx,
			`INSERT INTO session_tools(session_id, name, count) VALUES ($1, $2, $3)`,
			sessionID, pgText(t.Name), t.Count,
		); err != nil {
			return fmt.Errorf("insert session_tools(%s,%s): %w", sessionID, t.Name, err)
		}
	}
	return nil
}

func replaceSessionUsage(ctx context.Context, tx pgx.Tx, sessionID string, usage *prosav1.TokenUsage) error {
	if usage == nil {
		if _, err := tx.Exec(ctx, `DELETE FROM session_usage WHERE session_id = $1`, sessionID); err != nil {
			return fmt.Errorf("clear session_usage: %w", err)
		}
		return nil
	}
	_, err := tx.Exec(
		ctx, `
		INSERT INTO session_usage (
			session_id, total_tokens, input_tokens, output_tokens,
			cached_tokens, cache_read_tokens, cache_creation_tokens
		) VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (session_id) DO UPDATE SET
			total_tokens          = EXCLUDED.total_tokens,
			input_tokens          = EXCLUDED.input_tokens,
			output_tokens         = EXCLUDED.output_tokens,
			cached_tokens         = EXCLUDED.cached_tokens,
			cache_read_tokens     = EXCLUDED.cache_read_tokens,
			cache_creation_tokens = EXCLUDED.cache_creation_tokens
	`, sessionID,
		usage.TotalTokens, usage.InputTokens, usage.OutputTokens,
		usage.CachedTokens, usage.CacheReadTokens, usage.CacheCreationTokens,
	)
	if err != nil {
		return fmt.Errorf("upsert session_usage: %w", err)
	}
	return nil
}

func replaceTurns(ctx context.Context, tx pgx.Tx, sessionID string, turns []*prosav1.Turn) error {
	if _, err := tx.Exec(
		ctx,
		`DELETE FROM turns WHERE session_id = $1`, sessionID,
	); err != nil {
		return fmt.Errorf("clear turns: %w", err)
	}
	for _, t := range turns {
		kind := t.Kind
		if kind == "" {
			kind = session.KindMessage
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO turns(session_id, role, content, ts, kind, tool_name)
			VALUES ($1, $2, $3, $4, $5, $6)
		`, sessionID, pgText(t.Role), pgText(t.Content), tsToTime(t.Ts), pgText(kind), nullIfEmpty(t.ToolName)); err != nil {
			return fmt.Errorf("insert turn: %w", err)
		}
	}
	return nil
}

func recordSync(ctx context.Context, tx pgx.Tx, sessionID, hash string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO sync_state(session_id, last_hash, last_synced_at, projection_version) VALUES ($1, $2, $3, $4)
		ON CONFLICT (session_id) DO UPDATE SET
			last_hash          = EXCLUDED.last_hash,
			last_synced_at     = EXCLUDED.last_synced_at,
			projection_version = EXCLUDED.projection_version
	`, sessionID, hash, time.Now().UTC(), session.ProjectionVersion)
	if err != nil {
		return fmt.Errorf("record sync_state: %w", err)
	}
	return nil
}

func derefInt64(v *int64) int64 {
	if v == nil {
		return 0
	}
	return *v
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return pgText(s)
}

func pgText(s string) string {
	return strings.ReplaceAll(s, "\x00", " ")
}

func tsToTime(ts *timestamppb.Timestamp) time.Time {
	if ts == nil {
		return time.Time{}
	}
	return ts.AsTime()
}
