package handlers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"sync"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/internal/server/auth"
	"github.com/c3-oss/prosa/internal/sessionkind"
	"github.com/c3-oss/prosa/pkg/session"
)

const deviceLastSyncMinInterval = time.Minute

func (h *SessionsHandler) Push(ctx context.Context, req *connect.Request[prosav1.PushRequest]) (*connect.Response[prosav1.PushResponse], error) {
	deviceID, ok := auth.DeviceFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing device context"))
	}
	sess, err := validatePushSession(req.Msg.Session)
	if err != nil {
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

	current, err := h.pushAlreadyCurrent(ctx, sess)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if current {
		h.touchDeviceLastSync(ctx, deviceID, time.Now().UTC())
		return connect.NewResponse(&prosav1.PushResponse{Skipped: true}), nil
	}
	if err := validateRawBytes(sess, req.Msg.Raw); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}

	return h.commitPush(ctx, deviceID, sess, req.Msg.Turns, req.Msg.Tools, bytes.NewReader(req.Msg.Raw), int64(len(req.Msg.Raw)))
}

func (h *SessionsHandler) PushChunk(ctx context.Context, req *connect.Request[prosav1.PushChunkRequest]) (*connect.Response[prosav1.PushChunkResponse], error) {
	deviceID, ok := auth.DeviceFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing device context"))
	}
	sess, err := validatePushSession(req.Msg.Session)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	sess.DeviceId = deviceID
	if req.Msg.Offset < 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("push chunk offset must be non-negative"))
	}
	if req.Msg.Offset > sess.RawSize {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("push chunk offset %d exceeds raw size %d", req.Msg.Offset, sess.RawSize))
	}
	if req.Msg.Offset+int64(len(req.Msg.RawChunk)) > sess.RawSize {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("push chunk ending at %d exceeds raw size %d", req.Msg.Offset+int64(len(req.Msg.RawChunk)), sess.RawSize))
	}
	if !req.Msg.Final && len(req.Msg.RawChunk) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("push chunk raw_chunk is empty"))
	}

	// Serialize all chunks for this exact upload (device + session + hash)
	// so a retried stream racing the original can't interleave writes into
	// the shared temp file; distinct uploads use distinct keys and stay
	// concurrent. The temp lives in the process-global TempDir, so the lock
	// is package-global too.
	tmpPath := pushChunkTempPath(deviceID, sess)
	unlock := pushChunkLocks.lock(tmpPath)
	defer unlock()

	// Opportunistically reap staging files from uploads that were abandoned
	// mid-stream (client crashed before the final chunk). Runs once per
	// upload, when the first chunk arrives.
	if req.Msg.Offset == 0 {
		sweepStalePushChunks(os.TempDir(), time.Now())
	}

	current, err := h.pushAlreadyCurrent(ctx, sess)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if current {
		_ = os.Remove(tmpPath)
		h.touchDeviceLastSync(ctx, deviceID, time.Now().UTC())
		return connect.NewResponse(&prosav1.PushChunkResponse{Skipped: true}), nil
	}

	f, err := openPushChunkTemp(tmpPath, req.Msg.Offset)
	if err != nil {
		return nil, err
	}
	n, writeErr := f.Write(req.Msg.RawChunk)
	closeErr := f.Close()
	if writeErr != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("write raw temp file: %w", writeErr))
	}
	if closeErr != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("close raw temp file: %w", closeErr))
	}
	if n != len(req.Msg.RawChunk) {
		return nil, connect.NewError(connect.CodeInternal, io.ErrShortWrite)
	}

	received := req.Msg.Offset + int64(n)
	if !req.Msg.Final {
		return connect.NewResponse(&prosav1.PushChunkResponse{Accepted: true}), nil
	}
	defer func() { _ = os.Remove(tmpPath) }()

	tmp, err := os.Open(tmpPath)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("open raw temp file: %w", err))
	}
	defer func() { _ = tmp.Close() }()

	hasher := sha256.New()
	size, err := io.Copy(hasher, tmp)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("hash raw temp file: %w", err))
	}
	if size != received {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("raw size mismatch for session %s: staged %d bytes, received %d", sess.Id, size, received))
	}
	if err := validateRawIntegrity(sess, size, hex.EncodeToString(hasher.Sum(nil))); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("rewind raw temp file: %w", err))
	}

	resp, err := h.commitPush(ctx, deviceID, sess, req.Msg.Turns, req.Msg.Tools, tmp, size)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&prosav1.PushChunkResponse{
		Skipped: resp.Msg.Skipped,
		RawUri:  resp.Msg.RawUri,
	}), nil
}

func validatePushSession(sess *prosav1.Session) (*prosav1.Session, error) {
	if sess == nil {
		return nil, missingFields("session")
	}
	if sess.Id == "" || sess.RawHash == "" || sess.Agent == "" {
		return nil, missingFields("session.id", "session.raw_hash", "session.agent")
	}
	if err := validatePushedSessionID(sess.Id); err != nil {
		return nil, err
	}
	if err := validatePushedAgent(sess.Agent); err != nil {
		return nil, err
	}
	return sess, nil
}

func (h *SessionsHandler) pushAlreadyCurrent(ctx context.Context, sess *prosav1.Session) (bool, error) {
	var (
		lastHash          string
		projectionVersion int
	)
	err := h.Pool.QueryRow(
		ctx,
		`SELECT last_hash, projection_version FROM sync_state WHERE session_id = $1`, sess.Id,
	).Scan(&lastHash, &projectionVersion)
	if err == nil {
		return lastHash == sess.RawHash && projectionVersion >= session.ProjectionVersion, nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return false, fmt.Errorf("read sync_state: %w", err)
}

func pushChunkTempPath(deviceID string, sess *prosav1.Session) string {
	sum := sha256.Sum256([]byte(deviceID + "\x00" + sess.Id + "\x00" + sess.RawHash))
	return filepath.Join(os.TempDir(), "prosa-push-"+hex.EncodeToString(sum[:])+".part")
}

// pushChunkStaleAfter bounds how long an in-flight chunked upload may sit
// idle before its staging file is considered abandoned and reaped. No real
// upload takes anywhere near this long, so active uploads are never swept.
const pushChunkStaleAfter = 24 * time.Hour

// sweepStalePushChunks removes staging files from chunked uploads that never
// sent a final chunk (client crashed/aborted) and are older than
// pushChunkStaleAfter, so abandoned partials don't accumulate in TempDir.
// Best-effort: glob/stat/remove errors are ignored.
func sweepStalePushChunks(dir string, now time.Time) {
	matches, err := filepath.Glob(filepath.Join(dir, "prosa-push-*.part"))
	if err != nil {
		return
	}
	for _, p := range matches {
		info, statErr := os.Stat(p)
		if statErr != nil {
			continue
		}
		if now.Sub(info.ModTime()) > pushChunkStaleAfter {
			_ = os.Remove(p)
		}
	}
}

// pushChunkLocks serializes concurrent chunk writes to the same staging file.
var pushChunkLocks = &keyedMutex{}

// keyedMutex hands out a mutex per key and reclaims it once no goroutine
// holds or waits on it, so the map can't grow without bound across the
// server's lifetime.
type keyedMutex struct {
	mu sync.Mutex
	m  map[string]*keyedMutexEntry
}

type keyedMutexEntry struct {
	mu   sync.Mutex
	refs int
}

func (k *keyedMutex) lock(key string) func() {
	k.mu.Lock()
	if k.m == nil {
		k.m = make(map[string]*keyedMutexEntry)
	}
	e := k.m[key]
	if e == nil {
		e = &keyedMutexEntry{}
		k.m[key] = e
	}
	e.refs++
	k.mu.Unlock()

	e.mu.Lock()
	return func() {
		e.mu.Unlock()
		k.mu.Lock()
		e.refs--
		if e.refs == 0 {
			delete(k.m, key)
		}
		k.mu.Unlock()
	}
}

func openPushChunkTemp(tmpPath string, offset int64) (*os.File, error) {
	if offset == 0 {
		f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("create raw temp file: %w", err))
		}
		return f, nil
	}
	info, err := os.Stat(tmpPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("missing previous push chunks at offset %d", offset))
		}
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("stat raw temp file: %w", err))
	}
	if info.Size() != offset {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("push chunk offset mismatch: got %d, staged %d", offset, info.Size()))
	}
	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("open raw temp file: %w", err))
	}
	return f, nil
}

func validateRawBytes(sess *prosav1.Session, raw []byte) error {
	sum := sha256.Sum256(raw)
	return validateRawIntegrity(sess, int64(len(raw)), hex.EncodeToString(sum[:]))
}

func validateRawIntegrity(sess *prosav1.Session, gotSize int64, gotHash string) error {
	if gotSize != sess.RawSize {
		return fmt.Errorf("raw size mismatch for session %s: got %d bytes, want %d", sess.Id, gotSize, sess.RawSize)
	}
	if gotHash != sess.RawHash {
		return fmt.Errorf("raw hash mismatch for session %s: got %s, want %s", sess.Id, gotHash, sess.RawHash)
	}
	return nil
}

func (h *SessionsHandler) commitPush(ctx context.Context, deviceID string, sess *prosav1.Session, turns []*prosav1.Turn, tools []*prosav1.ToolUsage, raw io.Reader, rawSize int64) (*connect.Response[prosav1.PushResponse], error) {
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

	uri, err := h.Obj.Put(ctx, key, raw, rawSize)
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
	if err := replaceSessionTools(ctx, tx, sess.Id, tools); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if err := replaceSessionKinds(ctx, tx, sess.Id, sess.Kinds); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if err := deriveOrchestratorKinds(ctx, tx, sess); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if err := replaceTurns(ctx, tx, sess.Id, turns); err != nil {
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

// rawKey computes the canonical S3 key for a session's raw transcript.
//
//	<device-id>/<agent>/<YYYY>/<MM>/<id>.<ext>
//
// The extension is derived from the agent name; falls back to .bin for
// unknown agents.
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
	case "claude-code", "codex", "hermes":
		return ".jsonl"
	case "gemini":
		return ".json"
	case "cursor", "antigravity":
		return ".db"
	}
	return ".bin"
}

func upsertSession(ctx context.Context, tx pgx.Tx, s *prosav1.Session) error {
	_, err := tx.Exec(
		ctx, `
		INSERT INTO sessions (
			id, agent, device_id, project_path, project_remote, project_marker,
			started_at, last_activity_at, first_prompt, model,
			raw_uri, raw_hash, raw_size, parent_session_id, profile
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
			parent_session_id = EXCLUDED.parent_session_id,
			profile           = EXCLUDED.profile
	`,
		s.Id, s.Agent, s.DeviceId,
		nullIfEmpty(s.ProjectPath), nullIfEmpty(s.ProjectRemote), nullIfEmpty(s.ProjectMarker),
		tsToTime(s.StartedAt), tsToTime(s.LastActivityAt),
		nullIfEmpty(s.FirstPrompt), nullIfEmpty(s.Model),
		s.RawUri, s.RawHash, s.RawSize, nullIfEmpty(s.ParentSessionId), session.ProfileOrDefault(s.Profile),
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

// replaceSessionKinds writes the client-projected kinds (goal / workflow /
// ralph-loop). The orchestrator kind is intentionally dropped here and
// owned server-side by deriveOrchestratorKinds, since it depends on
// parent/child edges the server resolves itself.
func replaceSessionKinds(ctx context.Context, tx pgx.Tx, sessionID string, kinds []string) error {
	if _, err := tx.Exec(
		ctx,
		`DELETE FROM session_kinds WHERE session_id = $1`, sessionID,
	); err != nil {
		return fmt.Errorf("clear session_kinds: %w", err)
	}
	for _, k := range kinds {
		if k == sessionkind.KindOrchestrator {
			continue
		}
		if _, err := tx.Exec(
			ctx,
			`INSERT INTO session_kinds(session_id, kind) VALUES ($1, $2)
			 ON CONFLICT (session_id, kind) DO NOTHING`,
			sessionID, pgText(k),
		); err != nil {
			return fmt.Errorf("insert session_kinds(%s,%s): %w", sessionID, k, err)
		}
	}
	return nil
}

// deriveOrchestratorKinds reconciles the edge-dependent orchestrator kind
// around the just-committed session. It is order-independent across push
// arrival: marks the session's parent (a child just landed) and marks the
// session itself when it already has children. Both inserts are guarded by
// EXISTS so a child arriving before its parent never trips the foreign key.
func deriveOrchestratorKinds(ctx context.Context, tx pgx.Tx, sess *prosav1.Session) error {
	if pid := sess.ParentSessionId; pid != "" {
		if _, err := tx.Exec(ctx, `
			INSERT INTO session_kinds(session_id, kind)
			SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM sessions WHERE id = $1)
			ON CONFLICT (session_id, kind) DO NOTHING
		`, pid, sessionkind.KindOrchestrator); err != nil {
			return fmt.Errorf("mark parent orchestrator %s: %w", pid, err)
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO session_kinds(session_id, kind)
		SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM sessions WHERE parent_session_id = $1)
		ON CONFLICT (session_id, kind) DO NOTHING
	`, sess.Id, sessionkind.KindOrchestrator); err != nil {
		return fmt.Errorf("mark self orchestrator %s: %w", sess.Id, err)
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
	rows := make([][]any, 0, len(turns))
	for _, t := range turns {
		kind := t.Kind
		if kind == "" {
			kind = session.KindMessage
		}
		rows = append(rows, []any{
			sessionID,
			pgText(t.Role),
			pgText(t.Content),
			tsToTime(t.Ts),
			pgText(kind),
			nullIfEmpty(t.ToolName),
		})
	}
	if len(rows) == 0 {
		return nil
	}
	if _, err := tx.CopyFrom(
		ctx,
		pgx.Identifier{"turns"},
		[]string{"session_id", "role", "content", "ts", "kind", "tool_name"},
		pgx.CopyFromRows(rows),
	); err != nil {
		return fmt.Errorf("copy turns: %w", err)
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
