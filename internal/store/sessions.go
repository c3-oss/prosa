package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
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

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO sessions (
			id, agent, device_id, project_path,
			started_at, last_activity_at,
			first_prompt, model,
			raw_path, raw_hash, raw_size
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			agent            = excluded.agent,
			device_id        = excluded.device_id,
			project_path     = excluded.project_path,
			started_at       = excluded.started_at,
			last_activity_at = excluded.last_activity_at,
			first_prompt     = excluded.first_prompt,
			model            = excluded.model,
			raw_path         = excluded.raw_path,
			raw_hash         = excluded.raw_hash,
			raw_size         = excluded.raw_size
	`,
		sess.ID, sess.Agent, sess.DeviceID, nullableString(sess.ProjectPath),
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

// ListSessionsByRange returns sessions whose started_at falls within
// [since, until], newest first. Uses lexical comparison on RFC3339Nano
// strings — safe because that format is ISO 8601 sortable.
func (s *Store) ListSessionsByRange(ctx context.Context, since, until time.Time) ([]session.Session, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, agent, device_id, project_path,
		       started_at, last_activity_at,
		       first_prompt, model,
		       raw_path, raw_hash, raw_size
		FROM sessions
		WHERE started_at >= ? AND started_at <= ?
		ORDER BY started_at DESC
	`, formatTime(since), formatTime(until))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSessions(rows)
}

// GetSession returns a single session by id, or sql.ErrNoRows if missing.
func (s *Store) GetSession(ctx context.Context, id string) (session.Session, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, agent, device_id, project_path,
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

func scanSessions(rows *sql.Rows) ([]session.Session, error) {
	var out []session.Session
	for rows.Next() {
		var (
			sess        session.Session
			projectPath sql.NullString
			firstPrompt sql.NullString
			model       sql.NullString
			startedAt   string
			lastAct     string
		)
		if err := rows.Scan(
			&sess.ID, &sess.Agent, &sess.DeviceID, &projectPath,
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
