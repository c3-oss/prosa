package handlers

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"path"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/server/auth"
	"github.com/c3-oss/prosa/internal/server/storage"
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
	var lastHash string
	err := h.Pool.QueryRow(
		ctx,
		`SELECT last_hash FROM sync_state WHERE session_id = $1`, sess.Id,
	).Scan(&lastHash)
	if err == nil && lastHash == sess.RawHash {
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
			sessionID, t.Name, t.Count,
		); err != nil {
			return fmt.Errorf("insert session_tools(%s,%s): %w", sessionID, t.Name, err)
		}
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
		if _, err := tx.Exec(ctx, `
			INSERT INTO turns(session_id, role, content, ts) VALUES ($1, $2, $3, $4)
		`, sessionID, t.Role, t.Content, tsToTime(t.Ts)); err != nil {
			return fmt.Errorf("insert turn: %w", err)
		}
	}
	return nil
}

func recordSync(ctx context.Context, tx pgx.Tx, sessionID, hash string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO sync_state(session_id, last_hash, last_synced_at) VALUES ($1, $2, $3)
		ON CONFLICT (session_id) DO UPDATE SET
			last_hash      = EXCLUDED.last_hash,
			last_synced_at = EXCLUDED.last_synced_at
	`, sessionID, hash, time.Now().UTC())
	if err != nil {
		return fmt.Errorf("record sync_state: %w", err)
	}
	return nil
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func tsToTime(ts *timestamppb.Timestamp) time.Time {
	if ts == nil {
		return time.Time{}
	}
	return ts.AsTime()
}
