package store

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/c3-oss/prosa/pkg/session"
)

// InsertTurns replaces the turn set for a session in one transaction.
// Old rows are deleted first to keep re-imports idempotent. The FTS5
// virtual table is kept in sync by the AFTER INSERT / AFTER DELETE
// triggers defined in the migration; kind and tool_name live on the
// base table and are joined into search results when needed.
//
// Empty Turn.Kind defaults to "message" so importers that haven't
// learned the new shape yet still insert valid rows.
func (s *Store) InsertTurns(ctx context.Context, sessionID string, turns []session.Turn) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `DELETE FROM turns WHERE session_id = ?`, sessionID); err != nil {
		return fmt.Errorf("delete prior turns for %s: %w", sessionID, err)
	}

	if len(turns) == 0 {
		return tx.Commit()
	}

	stmt, err := tx.PrepareContext(
		ctx,
		`INSERT INTO turns(session_id, role, content, ts, kind, tool_name) VALUES (?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("prepare turn insert: %w", err)
	}
	defer stmt.Close()

	for i, t := range turns {
		kind := t.Kind
		if kind == "" {
			kind = session.KindMessage
		}
		var toolName any
		if t.ToolName != "" {
			toolName = t.ToolName
		}
		if _, err := stmt.ExecContext(
			ctx, sessionID, t.Role, t.Content, formatTime(t.Timestamp), kind, toolName,
		); err != nil {
			return fmt.Errorf("insert turn %d for %s: %w", i, sessionID, err)
		}
	}

	return tx.Commit()
}

// GetTurns returns every turn for sessionID in insertion (ts) order.
// Used by the push pipeline to mirror the local store onto the server,
// and by show to render the human view.
func (s *Store) GetTurns(ctx context.Context, sessionID string) ([]session.Turn, error) {
	rows, err := s.db.QueryContext(
		ctx,
		`SELECT role, content, ts, kind, tool_name FROM turns WHERE session_id = ? ORDER BY ts ASC, id ASC`,
		sessionID,
	)
	if err != nil {
		return nil, fmt.Errorf("query turns %s: %w", sessionID, err)
	}
	defer func() { _ = rows.Close() }()

	var out []session.Turn
	for rows.Next() {
		var (
			t        session.Turn
			ts       string
			toolName sql.NullString
		)
		if err := rows.Scan(&t.Role, &t.Content, &ts, &t.Kind, &toolName); err != nil {
			return nil, fmt.Errorf("scan turn: %w", err)
		}
		if tt, ok := parseTime(ts); ok {
			t.Timestamp = tt
		}
		if toolName.Valid {
			t.ToolName = toolName.String
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// GetSessionTools returns the (name, count) tool-usage rows for sessionID.
func (s *Store) GetSessionTools(ctx context.Context, sessionID string) ([]session.ToolUsage, error) {
	rows, err := s.db.QueryContext(
		ctx,
		`SELECT name, count FROM session_tools WHERE session_id = ? ORDER BY count DESC, name ASC`,
		sessionID,
	)
	if err != nil {
		return nil, fmt.Errorf("query session_tools %s: %w", sessionID, err)
	}
	defer func() { _ = rows.Close() }()

	var out []session.ToolUsage
	for rows.Next() {
		var t session.ToolUsage
		if err := rows.Scan(&t.Name, &t.Count); err != nil {
			return nil, fmt.Errorf("scan tool: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}
