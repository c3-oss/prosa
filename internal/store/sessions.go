package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/c3-oss/prosa/pkg/session"
)

// UpsertSession writes (or replaces) a session row plus its normalized
// session_tools rows in a single transaction. Existing session_tools rows
// for the same session id are deleted first so the post-condition matches
// the input slice exactly.
func (s *Store) UpsertSession(ctx context.Context, sess session.Session, tools []session.ToolUsage) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(
		ctx, `
		INSERT INTO sessions (
			id, agent, device_id, project_path,
			project_remote, project_marker,
			started_at, last_activity_at,
			first_prompt, model,
			raw_path, raw_hash, raw_size
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			agent            = excluded.agent,
			device_id        = excluded.device_id,
			project_path     = excluded.project_path,
			project_remote   = excluded.project_remote,
			project_marker   = excluded.project_marker,
			started_at       = excluded.started_at,
			last_activity_at = excluded.last_activity_at,
			first_prompt     = excluded.first_prompt,
			model            = excluded.model,
			raw_path         = excluded.raw_path,
			raw_hash         = excluded.raw_hash,
			raw_size         = excluded.raw_size
	`,
		sess.ID, sess.Agent, sess.DeviceID, nullableString(sess.ProjectPath),
		nullableString(sess.ProjectRemote), nullableString(sess.ProjectMarker),
		formatTime(sess.StartedAt), formatTime(sess.LastActivityAt),
		nullableString(sess.FirstPrompt), nullableString(sess.Model),
		sess.RawPath, sess.RawHash, sess.RawSize,
	); err != nil {
		return fmt.Errorf("upsert session %s: %w", sess.ID, err)
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM session_tools WHERE session_id = ?`, sess.ID); err != nil {
		return fmt.Errorf("clear session_tools %s: %w", sess.ID, err)
	}

	if len(tools) > 0 {
		stmt, err := tx.PrepareContext(ctx, `INSERT INTO session_tools(session_id, name, count) VALUES (?, ?, ?)`)
		if err != nil {
			return fmt.Errorf("prepare session_tools insert: %w", err)
		}
		defer stmt.Close()
		for _, t := range tools {
			if _, err := stmt.ExecContext(ctx, sess.ID, t.Name, t.Count); err != nil {
				return fmt.Errorf("insert session_tools(%s,%s): %w", sess.ID, t.Name, err)
			}
		}
	}

	return tx.Commit()
}

// SessionFilter narrows ListSessions. Since/Until are required; the
// pointer fields are optional and combine with AND semantics. ProjectExact
// is the cwd-anchored auto-filter (exact equality); ProjectMatch is
// substring (used by the --project flag). Agent matches the canonical
// agent string ("claude-code" | "codex"). DeviceName matches against
// devices.friendly_name via JOIN.
type SessionFilter struct {
	Since, Until time.Time
	ProjectExact *string // exact match on sessions.project_path
	ProjectMatch *string // substring match on sessions.project_path
	// ProjectRemote matches sessions.project_remote exactly. Used by the
	// new git-remote-anchored auto-detect (INTENT §5 step 1).
	ProjectRemote *string
	// ProjectMarker matches sessions.project_marker exactly. Used by the
	// .prosa.yaml-anchored auto-detect (INTENT §5 step 2).
	ProjectMarker *string
	Agent         *string
	DeviceName    *string
}

// ListSessionsByRange is a thin convenience wrapper preserving the cut-1
// signature for callers that don't need the additional filter dimensions.
func (s *Store) ListSessionsByRange(ctx context.Context, since, until time.Time) ([]session.Session, error) {
	return s.ListSessions(ctx, SessionFilter{Since: since, Until: until})
}

// ListSessions runs the configurable session query. It assembles the
// WHERE clause from the populated filter fields and returns sessions
// ordered newest first. Empty result is not an error.
func (s *Store) ListSessions(ctx context.Context, f SessionFilter) ([]session.Session, error) {
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

	query := `
		SELECT s.id, s.agent, s.device_id, s.project_path,
		       s.project_remote, s.project_marker,
		       s.started_at, s.last_activity_at,
		       s.first_prompt, s.model,
		       s.raw_path, s.raw_hash, s.raw_size
		FROM sessions s` + join + `
		WHERE ` + strings.Join(conds, " AND ") + `
		ORDER BY s.started_at DESC
	`

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSessions(rows)
}

// DistinctProjectPaths returns every non-null project_path stored. Used
// by the CLI to drive auto-detection of the current project from cwd.
func (s *Store) DistinctProjectPaths(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(
		ctx,
		`SELECT DISTINCT project_path FROM sessions WHERE project_path IS NOT NULL AND project_path != ''`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ProjectRemoteExists reports whether at least one session has a
// project_remote equal to url. Used by DetectProject to confirm the
// store already knows the current cwd's remote before asking the
// timeline to scope by it.
func (s *Store) ProjectRemoteExists(ctx context.Context, url string) (bool, error) {
	var n int
	if err := s.db.QueryRowContext(
		ctx,
		`SELECT COUNT(*) FROM sessions WHERE project_remote = ? LIMIT 1`,
		url,
	).Scan(&n); err != nil {
		return false, fmt.Errorf("count project_remote: %w", err)
	}
	return n > 0, nil
}

// ProjectMarkerExists reports whether at least one session has a
// project_marker equal to name. Same role as ProjectRemoteExists but
// for the .prosa.yaml-anchored identity.
func (s *Store) ProjectMarkerExists(ctx context.Context, name string) (bool, error) {
	var n int
	if err := s.db.QueryRowContext(
		ctx,
		`SELECT COUNT(*) FROM sessions WHERE project_marker = ? LIMIT 1`,
		name,
	).Scan(&n); err != nil {
		return false, fmt.Errorf("count project_marker: %w", err)
	}
	return n > 0, nil
}

// GetSession returns a single session by id, or sql.ErrNoRows if missing.
func (s *Store) GetSession(ctx context.Context, id string) (session.Session, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, agent, device_id, project_path,
		       project_remote, project_marker,
		       started_at, last_activity_at,
		       first_prompt, model,
		       raw_path, raw_hash, raw_size
		FROM sessions WHERE id = ?
	`, id)
	if err != nil {
		return session.Session{}, err
	}
	defer rows.Close()
	list, err := scanSessions(rows)
	if err != nil {
		return session.Session{}, err
	}
	if len(list) == 0 {
		return session.Session{}, sql.ErrNoRows
	}
	return list[0], nil
}

// ManifestRow is the minimal projection used by the catch-up reconcile
// path: enough to ask "does the server already have this id with this
// hash?" and locate the raw on disk if we need to re-push it.
type ManifestRow struct {
	ID      string
	RawHash string
	RawPath string
}

// ListSessionsManifest paginates every session for a given device by id
// ASC. afterID = "" starts the scan; limit <= 0 means "all rows in one
// page" (used by the CLI which holds the whole local set in memory
// during reconcile). The composite (device_id, id) index from migration
// 0003 makes this an index-only walk.
func (s *Store) ListSessionsManifest(ctx context.Context, deviceID, afterID string, limit int) ([]ManifestRow, error) {
	q := `
		SELECT id, raw_hash, raw_path
		FROM sessions
		WHERE device_id = ? AND id > ?
		ORDER BY id ASC`
	args := []any{deviceID, afterID}
	if limit > 0 {
		q += ` LIMIT ?`
		args = append(args, limit)
	}
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ManifestRow
	for rows.Next() {
		var r ManifestRow
		if err := rows.Scan(&r.ID, &r.RawHash, &r.RawPath); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func scanSessions(rows *sql.Rows) ([]session.Session, error) {
	var out []session.Session
	for rows.Next() {
		var (
			sess          session.Session
			projectPath   sql.NullString
			projectRemote sql.NullString
			projectMarker sql.NullString
			firstPrompt   sql.NullString
			model         sql.NullString
			startedAt     string
			lastAct       string
		)
		if err := rows.Scan(
			&sess.ID, &sess.Agent, &sess.DeviceID, &projectPath,
			&projectRemote, &projectMarker,
			&startedAt, &lastAct,
			&firstPrompt, &model,
			&sess.RawPath, &sess.RawHash, &sess.RawSize,
		); err != nil {
			return nil, err
		}
		if projectPath.Valid {
			v := projectPath.String
			sess.ProjectPath = &v
		}
		if projectRemote.Valid {
			v := projectRemote.String
			sess.ProjectRemote = &v
		}
		if projectMarker.Valid {
			v := projectMarker.String
			sess.ProjectMarker = &v
		}
		if firstPrompt.Valid {
			v := firstPrompt.String
			sess.FirstPrompt = &v
		}
		if model.Valid {
			v := model.String
			sess.Model = &v
		}
		if t, ok := parseTime(startedAt); ok {
			sess.StartedAt = t
		}
		if t, ok := parseTime(lastAct); ok {
			sess.LastActivityAt = t
		}
		out = append(out, sess)
	}
	return out, rows.Err()
}

func formatTime(t time.Time) string {
	return t.UTC().Format(time.RFC3339Nano)
}

func parseTime(s string) (time.Time, bool) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, true
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, true
	}
	return time.Time{}, false
}

func nullableString(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

// ErrSessionNotFound is returned by helpers that want a typed miss; thin
// alias so callers don't import database/sql just to compare.
var ErrSessionNotFound = errors.New("session not found")
