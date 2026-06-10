package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/c3-oss/prosa/internal/sessiontext"
	"github.com/c3-oss/prosa/pkg/session"
)

// escapeLikePattern escapes the SQLite LIKE meta-characters % and _
// in a literal prefix so a value like "foo_bar" matches verbatim.
// Uses backslash as the escape character (callers must append the
// "%" wildcard themselves).
func escapeLikePattern(s string) string {
	r := strings.NewReplacer(
		`\`, `\\`,
		`%`, `\%`,
		`_`, `\_`,
	)
	return r.Replace(s)
}

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

	if err := upsertSessionTx(ctx, tx, sess, tools); err != nil {
		return err
	}
	return tx.Commit()
}

// upsertSessionTx writes the session row, session_usage, and session_tools
// inside an existing transaction. UpsertSession wraps it in its own tx;
// WriteSession reuses it so the whole projection commits atomically.
func upsertSessionTx(ctx context.Context, tx *sql.Tx, sess session.Session, tools []session.ToolUsage) error {
	if _, err := tx.ExecContext(
		ctx, `
		INSERT INTO sessions (
			id, agent, device_id, project_path,
			project_remote, project_marker,
			started_at, last_activity_at,
			first_prompt, model,
			raw_path, raw_hash, raw_size,
			parent_session_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			agent             = excluded.agent,
			device_id         = excluded.device_id,
			project_path      = excluded.project_path,
			project_remote    = excluded.project_remote,
			project_marker    = excluded.project_marker,
			started_at        = excluded.started_at,
			last_activity_at  = excluded.last_activity_at,
			first_prompt      = excluded.first_prompt,
			model             = excluded.model,
			raw_path          = excluded.raw_path,
			raw_hash          = excluded.raw_hash,
			raw_size          = excluded.raw_size,
			parent_session_id = excluded.parent_session_id
	`,
		sess.ID, sess.Agent, sess.DeviceID, nullableString(sess.ProjectPath),
		nullableString(sess.ProjectRemote), nullableString(sess.ProjectMarker),
		formatTime(sess.StartedAt), formatTime(sess.LastActivityAt),
		nullableString(sess.FirstPrompt), nullableString(sess.Model),
		sess.RawPath, sess.RawHash, sess.RawSize,
		nullableString(sess.ParentSessionID),
	); err != nil {
		return fmt.Errorf("upsert session %s: %w", sess.ID, err)
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM session_tools WHERE session_id = ?`, sess.ID); err != nil {
		return fmt.Errorf("clear session_tools %s: %w", sess.ID, err)
	}

	if sess.Usage == nil {
		if _, err := tx.ExecContext(ctx, `DELETE FROM session_usage WHERE session_id = ?`, sess.ID); err != nil {
			return fmt.Errorf("clear session_usage %s: %w", sess.ID, err)
		}
	} else if _, err := tx.ExecContext(
		ctx, `
		INSERT INTO session_usage (
			session_id, total_tokens, input_tokens, output_tokens,
			cached_tokens, cache_read_tokens, cache_creation_tokens
		) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET
			total_tokens          = excluded.total_tokens,
			input_tokens          = excluded.input_tokens,
			output_tokens         = excluded.output_tokens,
			cached_tokens         = excluded.cached_tokens,
			cache_read_tokens     = excluded.cache_read_tokens,
			cache_creation_tokens = excluded.cache_creation_tokens
	`, sess.ID,
		sess.Usage.TotalTokens, sess.Usage.InputTokens, sess.Usage.OutputTokens,
		sess.Usage.CachedTokens, sess.Usage.CacheReadTokens, sess.Usage.CacheCreationTokens,
	); err != nil {
		return fmt.Errorf("upsert session_usage %s: %w", sess.ID, err)
	}

	// Direct Exec rather than a prepared statement: tool counts are a
	// handful of rows per session, so the prepare cost isn't amortized, and
	// it avoids a stmt.Close() whose error could interact with the deferred
	// rollback/commit.
	for _, t := range tools {
		if _, err := tx.ExecContext(
			ctx,
			`INSERT INTO session_tools(session_id, name, count) VALUES (?, ?, ?)`,
			sess.ID, t.Name, t.Count,
		); err != nil {
			return fmt.Errorf("insert session_tools(%s,%s): %w", sess.ID, t.Name, err)
		}
	}

	return nil
}

// SessionFilter narrows ListSessions and Search. Since/Until are
// required; the pointer fields are optional and combine with AND
// semantics. ProjectExact is the cwd-anchored auto-filter (exact
// equality on project_path); ProjectMatch is substring (used by the
// --project flag) and ORs across project_path / project_remote /
// project_marker so `--project movaincentivo` finds sessions stored
// under any of the three columns. Agent matches the canonical agent
// string ("claude-code" | "codex"). DeviceName matches against
// devices.friendly_name via JOIN. Limit > 0 caps the returned rows.
type SessionFilter struct {
	Since, Until time.Time
	ProjectExact *string // exact match on sessions.project_path
	// ProjectMatch is the substring filter from --project. It matches when
	// any of project_path / project_remote / project_marker contains the
	// value as a substring, so the leading wildcard can defeat the project
	// indexes. Prefer the exact fields when the caller has a full path,
	// remote, or marker.
	ProjectMatch *string
	// ProjectRemote matches sessions.project_remote exactly. Used by
	// the git-remote-anchored auto-detect (INTENT §5 step 1).
	ProjectRemote *string
	// ProjectMarker matches sessions.project_marker exactly. Used by
	// the .prosa.yaml-anchored auto-detect (INTENT §5 step 2).
	ProjectMarker *string
	Agent         *string
	DeviceName    *string
	// Limit caps the number of rows returned. 0 means no limit.
	Limit int
}

// applyProjectMatch appends the OR-chain WHERE fragment for a ProjectMatch
// filter. Centralized so ListSessions and Search stay in lockstep; exact
// identity filters remain indexable.
func applyProjectMatch(conds []string, args []any, match string) ([]string, []any) {
	conds = append(conds, "(s.project_path LIKE ? OR s.project_remote LIKE ? OR s.project_marker LIKE ?)")
	pattern := "%" + match + "%"
	args = append(args, pattern, pattern, pattern)
	return conds, args
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
		conds, args = applyProjectMatch(conds, args, *f.ProjectMatch)
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
		       s.raw_path, s.raw_hash, s.raw_size,
		       s.parent_session_id,
		       su.session_id, su.total_tokens, su.input_tokens, su.output_tokens,
		       su.cached_tokens, su.cache_read_tokens, su.cache_creation_tokens
		FROM sessions s
		LEFT JOIN session_usage su ON su.session_id = s.id` + join + `
		WHERE ` + strings.Join(conds, " AND ") + `
		ORDER BY s.started_at DESC
	`
	if f.Limit > 0 {
		query += ` LIMIT ?`
		args = append(args, f.Limit)
	}

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

// ListChildren returns every session whose parent_session_id matches
// parentID, ordered started_at ascending so the panel can show them
// in the order they were spawned. Empty parentID returns an empty
// slice (callers shouldn't ask for "children of nothing").
func (s *Store) ListChildren(ctx context.Context, parentID string) ([]session.Session, error) {
	if parentID == "" {
		return nil, nil
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT s.id, s.agent, s.device_id, s.project_path,
		       s.project_remote, s.project_marker,
		       s.started_at, s.last_activity_at,
		       s.first_prompt, s.model,
		       s.raw_path, s.raw_hash, s.raw_size,
		       s.parent_session_id,
		       su.session_id, su.total_tokens, su.input_tokens, su.output_tokens,
		       su.cached_tokens, su.cache_read_tokens, su.cache_creation_tokens
		FROM sessions s
		LEFT JOIN session_usage su ON su.session_id = s.id
		WHERE s.parent_session_id = ?
		ORDER BY s.started_at ASC
	`, parentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSessions(rows)
}

// GetSession returns a single session by id, or sql.ErrNoRows if missing.
func (s *Store) GetSession(ctx context.Context, id string) (session.Session, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT s.id, s.agent, s.device_id, s.project_path,
		       s.project_remote, s.project_marker,
		       s.started_at, s.last_activity_at,
		       s.first_prompt, s.model,
		       s.raw_path, s.raw_hash, s.raw_size,
		       s.parent_session_id,
		       su.session_id, su.total_tokens, su.input_tokens, su.output_tokens,
		       su.cached_tokens, su.cache_read_tokens, su.cache_creation_tokens
		FROM sessions s
		LEFT JOIN session_usage su ON su.session_id = s.id
		WHERE s.id = ?
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

// BoilerplateCandidate is one row returned by
// ListSessionsWithBoilerplatePrompt: the bits the denoise pass needs
// to reopen the raw and update the row.
type BoilerplateCandidate struct {
	ID      string
	RawPath string
}

// ListSessionsWithBoilerplatePrompt returns rows whose stored
// first_prompt starts with one of the known agent-injected meta
// prefixes. Used by `prosa sync` to one-shot denoise legacy data
// without forcing a full reimport.
//
// The pattern list is sourced from internal/sessiontext.Prefixes so
// adding a new wrapper in one place automatically extends both the
// importer-time classifier and the SQL denoise sweep — no silent
// drift between Go and SQL anymore.
func (s *Store) ListSessionsWithBoilerplatePrompt(ctx context.Context, limit int) ([]BoilerplateCandidate, error) {
	if len(sessiontext.Prefixes) == 0 {
		return nil, nil
	}
	clauses := make([]string, 0, len(sessiontext.Prefixes))
	args := make([]any, 0, len(sessiontext.Prefixes)+1)
	for _, p := range sessiontext.Prefixes {
		clauses = append(clauses, `first_prompt LIKE ? ESCAPE '\'`)
		args = append(args, escapeLikePattern(p)+"%")
	}
	q := `SELECT id, raw_path FROM sessions
		WHERE first_prompt IS NOT NULL AND (` +
		strings.Join(clauses, " OR ") + `)`
	if limit > 0 {
		q += ` LIMIT ?`
		args = append(args, limit)
	}
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BoilerplateCandidate
	for rows.Next() {
		var c BoilerplateCandidate
		if err := rows.Scan(&c.ID, &c.RawPath); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// UpdateFirstPrompt rewrites just the first_prompt column for a
// session. Used by the denoise pass; everything else stays untouched.
func (s *Store) UpdateFirstPrompt(ctx context.Context, sessionID, prompt string) error {
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE sessions SET first_prompt = ? WHERE id = ?`,
		prompt, sessionID,
	)
	return err
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
			parentID      sql.NullString
			usageSession  sql.NullString
			totalTokens   sql.NullInt64
			inputTokens   sql.NullInt64
			outputTokens  sql.NullInt64
			cachedTokens  sql.NullInt64
			cacheRead     sql.NullInt64
			cacheCreate   sql.NullInt64
			startedAt     string
			lastAct       string
		)
		if err := rows.Scan(
			&sess.ID, &sess.Agent, &sess.DeviceID, &projectPath,
			&projectRemote, &projectMarker,
			&startedAt, &lastAct,
			&firstPrompt, &model,
			&sess.RawPath, &sess.RawHash, &sess.RawSize,
			&parentID,
			&usageSession, &totalTokens, &inputTokens, &outputTokens,
			&cachedTokens, &cacheRead, &cacheCreate,
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
		if parentID.Valid && parentID.String != "" {
			v := parentID.String
			sess.ParentSessionID = &v
		}
		if t, ok := parseTime(startedAt); ok {
			sess.StartedAt = t
		}
		if t, ok := parseTime(lastAct); ok {
			sess.LastActivityAt = t
		}
		if usageSession.Valid {
			sess.Usage = &session.TokenUsage{
				TotalTokens:         totalTokens.Int64,
				InputTokens:         inputTokens.Int64,
				OutputTokens:        outputTokens.Int64,
				CachedTokens:        cachedTokens.Int64,
				CacheReadTokens:     cacheRead.Int64,
				CacheCreationTokens: cacheCreate.Int64,
			}
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
