package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/c3-oss/prosa/pkg/session"
)

// SearchHit is the per-session result of a Search call: the session
// metadata plus the highest-ranked snippet from any of its turns.
type SearchHit struct {
	Session session.Session
	Snippet string
	Role    string // "user" or "assistant" — which turn produced the snippet
}

// SnippetMarkStart and SnippetMarkEnd wrap matched terms in the snippet
// text. The CLI render layer recognizes them and applies Lipgloss styling.
const (
	SnippetMarkStart = "«"
	SnippetMarkEnd   = "»"
)

// Search runs an FTS5 MATCH query against turns_fts and returns at most
// `limit` hits, deduplicated by session (highest-ranked turn wins). The
// SessionFilter reuses the same filter semantics as ListSessions so
// `prosa search` honors --project / --agent / --device / --last.
func (s *Store) Search(ctx context.Context, query string, f SessionFilter, limit int) ([]SearchHit, error) {
	if strings.TrimSpace(query) == "" {
		return nil, fmt.Errorf("empty search query")
	}
	if limit <= 0 {
		limit = 20
	}

	conds := []string{"s.started_at >= ?", "s.started_at <= ?"}
	args := []any{query, formatTime(f.Since), formatTime(f.Until)}

	if f.ProjectExact != nil {
		conds = append(conds, "s.project_path = ?")
		args = append(args, *f.ProjectExact)
	}
	if f.ProjectMatch != nil {
		conds = append(conds, "s.project_path LIKE ?")
		args = append(args, "%"+*f.ProjectMatch+"%")
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

	// SQLite FTS5's snippet() only works when the query is a direct
	// turns_fts MATCH — wrapping it in a CTE that joins another table
	// and then references the snippet from the outer query throws
	// "unable to use function snippet in the requested context".
	//
	// So we run a flat query ordered by rank and dedupe by session_id
	// in Go (rows already arrive in rank order, so the first hit per
	// session is the best). To make sure we have enough candidate rows
	// to reach `limit` unique sessions even when one session dominates
	// the FTS results, we ask SQLite for limit*50 (floored at 500).
	sqlLimit := limit * 50
	if sqlLimit < 500 {
		sqlLimit = 500
	}

	q := fmt.Sprintf(`
		SELECT s.id, s.agent, s.device_id, s.project_path,
		       s.started_at, s.last_activity_at,
		       s.first_prompt, s.model,
		       s.raw_path, s.raw_hash, s.raw_size,
		       t.role,
		       snippet(turns_fts, 1, '%s', '%s', '…', 16) AS snippet,
		       rank
		FROM turns_fts
		JOIN turns t ON t.id = turns_fts.rowid
		JOIN sessions s ON s.id = t.session_id%s
		WHERE turns_fts MATCH ? AND %s
		ORDER BY rank
		LIMIT ?
	`,
		SnippetMarkStart, SnippetMarkEnd,
		join,
		strings.Join(conds, " AND "),
	)
	args = append(args, sqlLimit)

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	seen := make(map[string]struct{}, limit)
	out := make([]SearchHit, 0, limit)
	for rows.Next() {
		var (
			h           SearchHit
			projectPath sql.NullString
			firstPrompt sql.NullString
			model       sql.NullString
			startedAt   string
			lastAct     string
			rank        float64
		)
		if err := rows.Scan(
			&h.Session.ID, &h.Session.Agent, &h.Session.DeviceID, &projectPath,
			&startedAt, &lastAct,
			&firstPrompt, &model,
			&h.Session.RawPath, &h.Session.RawHash, &h.Session.RawSize,
			&h.Role, &h.Snippet, &rank,
		); err != nil {
			return nil, err
		}
		if _, dup := seen[h.Session.ID]; dup {
			continue
		}
		seen[h.Session.ID] = struct{}{}

		if projectPath.Valid {
			v := projectPath.String
			h.Session.ProjectPath = &v
		}
		if firstPrompt.Valid {
			v := firstPrompt.String
			h.Session.FirstPrompt = &v
		}
		if model.Valid {
			v := model.String
			h.Session.Model = &v
		}
		if t, ok := parseTime(startedAt); ok {
			h.Session.StartedAt = t
		}
		if t, ok := parseTime(lastAct); ok {
			h.Session.LastActivityAt = t
		}
		out = append(out, h)
		if len(out) >= limit {
			break
		}
	}
	return out, rows.Err()
}
