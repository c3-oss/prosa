package handlers

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/server/auth"
	"github.com/c3-oss/prosa/pkg/session"
)

const deviceLastSyncMinInterval = time.Minute

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
		h.touchDeviceLastSync(ctx, deviceID, time.Now().UTC())
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

	if err := tx.Commit(ctx); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	committed = true
	h.touchDeviceLastSync(ctx, deviceID, time.Now().UTC())
	return connect.NewResponse(&prosav1.PushResponse{Skipped: false, RawUri: uri}), nil
}

// touchDeviceLastSync records recent device activity outside the session
// ingestion transaction. The WHERE guard keeps a burst of pushes from the
// same device from repeatedly updating and locking the same devices row.
func (h *SessionsHandler) touchDeviceLastSync(ctx context.Context, deviceID string, now time.Time) {
	touchCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	threshold := now.Add(-deviceLastSyncMinInterval)
	if _, err := h.Pool.Exec(
		touchCtx,
		`UPDATE devices
		 SET last_sync = $1
		 WHERE id = $2
		   AND (last_sync IS NULL OR last_sync < $3)`,
		now, deviceID, threshold,
	); err != nil {
		slog.WarnContext(ctx, "push: device last_sync touch failed", "device", deviceID, "err", err)
	}
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
