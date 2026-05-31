package handlers

import (
	"bytes"
	"context"
	"errors"
	"fmt"
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

	// Force the device_id to the authenticated caller; clients can't
	// impersonate another device by setting a different value on the
	// wire.
	sess.DeviceId = deviceID

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
		return connect.NewResponse(&prosav1.PushResponse{Skipped: true}), nil
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("read sync_state: %w", err))
	}

	// Upload raw to S3.
	started := sess.StartedAt.AsTime().UTC()
	key := rawKey(deviceID, sess.Agent, sess.Id, started)
	uri, err := h.Obj.Put(ctx, key, bytes.NewReader(req.Msg.Raw), int64(len(req.Msg.Raw)))
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("upload raw: %w", err))
	}
	sess.RawUri = uri

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
	return connect.NewResponse(&prosav1.PushResponse{Skipped: false, RawUri: uri}), nil
}

// List returns sessions filtered by since/until + optional project /
// agent / device dimensions. Device callers are auto-scoped to their
// own device_id (cannot see other devices' rows); owner callers
// (panel) get a cross-device list and may further narrow via
// device_name.
func (h *SessionsHandler) List(ctx context.Context, req *connect.Request[prosav1.ListRequest]) (*connect.Response[prosav1.ListResponse], error) {
	callerDevice, isDevice := auth.DeviceFromContext(ctx)
	if !isDevice && !auth.IsOwner(ctx) {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing device or owner context"))
	}
	if req.Msg.Since == nil || req.Msg.Until == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, missingFields("since", "until"))
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
	if req.Msg.ProjectMatch != "" {
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
	limit := req.Msg.Limit
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	q := fmt.Sprintf(`
		SELECT s.id, s.agent, s.device_id, s.project_path, s.project_remote, s.project_marker,
		       s.started_at, s.last_activity_at, s.first_prompt, s.model,
		       s.raw_uri, s.raw_hash, s.raw_size,
		       su.session_id, su.total_tokens, su.input_tokens, su.output_tokens,
		       su.cached_tokens, su.cache_read_tokens, su.cache_creation_tokens
		FROM sessions s
		LEFT JOIN session_usage su ON su.session_id = s.id%s
		WHERE %s
		ORDER BY s.started_at DESC
		LIMIT $%d
	`, join, joinAnd(conds), idx)
	args = append(args, limit)

	rows, err := h.Pool.Query(ctx, q, args...)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	defer rows.Close()

	out := &prosav1.ListResponse{}
	for rows.Next() {
		s, err := scanSessionRow(rows)
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, err)
		}
		out.Sessions = append(out.Sessions, s)
	}
	return connect.NewResponse(out), rows.Err()
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
		SELECT id, agent, device_id, project_path, project_remote, project_marker,
		       started_at, last_activity_at, first_prompt, model,
		       raw_uri, raw_hash, raw_size,
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
		&usageSession, &totalTokens, &inputTokens, &outputTokens,
		&cachedTokens, &cacheReadTokens, &cacheCreationTokens,
		&turnID, &turnTS, &role, &kind, &toolName,
		&snippet, &rank,
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
	case "cursor":
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
			raw_uri, raw_hash, raw_size
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		ON CONFLICT (id) DO UPDATE SET
			agent            = EXCLUDED.agent,
			device_id        = EXCLUDED.device_id,
			project_path     = EXCLUDED.project_path,
			project_remote   = EXCLUDED.project_remote,
			project_marker   = EXCLUDED.project_marker,
			started_at       = EXCLUDED.started_at,
			last_activity_at = EXCLUDED.last_activity_at,
			first_prompt    = EXCLUDED.first_prompt,
			model            = EXCLUDED.model,
			raw_uri          = EXCLUDED.raw_uri,
			raw_hash         = EXCLUDED.raw_hash,
			raw_size         = EXCLUDED.raw_size
	`,
		s.Id, s.Agent, s.DeviceId,
		nullIfEmpty(s.ProjectPath), nullIfEmpty(s.ProjectRemote), nullIfEmpty(s.ProjectMarker),
		tsToTime(s.StartedAt), tsToTime(s.LastActivityAt),
		nullIfEmpty(s.FirstPrompt), nullIfEmpty(s.Model),
		s.RawUri, s.RawHash, s.RawSize,
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
