package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
	"unicode"

	"github.com/c3-oss/prosa/pkg/session"
)

// SearchHit is the per-session result of a Search call: the session
// metadata plus the highest-ranked snippet from any of its turns and
// the metadata needed to fetch the exact evidence without re-reading
// the raw transcript.
type SearchHit struct {
	Session session.Session
	Snippet string
	Role    string // "user" | "assistant" | "tool"
	// TurnID is the matching turn's primary key (turns.id).
	TurnID int64
	// TurnTS is the timestamp of the matching turn.
	TurnTS time.Time
	// Kind mirrors Turn.Kind for the matched turn ("message" |
	// "tool_result" | "operational"). Empty when older rows.
	Kind string
	// ToolName carries Turn.ToolName when the matched turn is a tool
	// projection; empty otherwise.
	ToolName string
	// MatchField names the document field that produced the match.
	// Currently always MatchFieldTurnContent; reserved for future
	// session-level matches (first_prompt, project name).
	MatchField string
	// Rank is SQLite FTS5's bm25() score. Lower means more relevant;
	// rows arrive sorted ascending.
	Rank float64
}

// MatchFieldTurnContent is the only value SearchHit.MatchField takes
// today. Held as a constant so renderers don't sprinkle the literal
// across packages.
const MatchFieldTurnContent = "turn.content"

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
	matchQuery := fts5SearchQuery(query)
	args := []any{matchQuery, formatTime(f.Since), formatTime(f.Until)}

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
	if f.Profile != nil {
		conds = append(conds, "s.profile = ?")
		args = append(args, *f.Profile)
	}
	join := ""
	if f.DeviceName != nil {
		join = " JOIN devices d ON d.id = s.device_id"
		conds = append(conds, "(s.device_id = ? OR d.friendly_name = ?)")
		args = append(args, *f.DeviceName, *f.DeviceName)
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

	q := fmt.Sprintf(
		`
		SELECT s.id, s.agent, s.device_id, s.project_path,
		       s.project_remote, s.project_marker,
		       s.started_at, s.last_activity_at,
		       s.first_prompt, s.model,
		       s.raw_path, s.raw_hash, s.raw_size,
		       s.parent_session_id, s.profile,
		       su.session_id, su.total_tokens, su.input_tokens, su.output_tokens,
		       su.cached_tokens, su.cache_read_tokens, su.cache_creation_tokens,
		       t.id, t.ts, t.role, t.kind, t.tool_name,
		       snippet(turns_fts, 1, '%s', '%s', '…', 16) AS snippet,
		       rank
		FROM turns_fts
		JOIN turns t ON t.id = turns_fts.rowid
		JOIN sessions s ON s.id = t.session_id
		LEFT JOIN session_usage su ON su.session_id = s.id%s
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
		if isFTS5QueryError(err) {
			return nil, fmt.Errorf("invalid search query %q", query)
		}
		return nil, err
	}
	defer rows.Close()

	seen := make(map[string]struct{}, limit)
	out := make([]SearchHit, 0, limit)
	for rows.Next() {
		var (
			h             SearchHit
			projectPath   sql.NullString
			projectRemote sql.NullString
			projectMarker sql.NullString
			firstPrompt   sql.NullString
			model         sql.NullString
			parentID      sql.NullString
			profile       string
			usageSession  sql.NullString
			totalTokens   sql.NullInt64
			inputTokens   sql.NullInt64
			outputTokens  sql.NullInt64
			cachedTokens  sql.NullInt64
			cacheRead     sql.NullInt64
			cacheCreate   sql.NullInt64
			startedAt     string
			lastAct       string
			turnTS        string
			toolName      sql.NullString
		)
		if err := rows.Scan(
			&h.Session.ID, &h.Session.Agent, &h.Session.DeviceID, &projectPath,
			&projectRemote, &projectMarker,
			&startedAt, &lastAct,
			&firstPrompt, &model,
			&h.Session.RawPath, &h.Session.RawHash, &h.Session.RawSize,
			&parentID, &profile,
			&usageSession, &totalTokens, &inputTokens, &outputTokens,
			&cachedTokens, &cacheRead, &cacheCreate,
			&h.TurnID, &turnTS, &h.Role, &h.Kind, &toolName,
			&h.Snippet, &h.Rank,
		); err != nil {
			return nil, err
		}
		if _, dup := seen[h.Session.ID]; dup {
			continue
		}
		seen[h.Session.ID] = struct{}{}

		if t, ok := parseTime(turnTS); ok {
			h.TurnTS = t
		}
		if toolName.Valid {
			h.ToolName = toolName.String
		}
		h.MatchField = MatchFieldTurnContent

		if projectPath.Valid {
			v := projectPath.String
			h.Session.ProjectPath = &v
		}
		if projectRemote.Valid {
			v := projectRemote.String
			h.Session.ProjectRemote = &v
		}
		if projectMarker.Valid {
			v := projectMarker.String
			h.Session.ProjectMarker = &v
		}
		if firstPrompt.Valid {
			v := firstPrompt.String
			h.Session.FirstPrompt = &v
		}
		if model.Valid {
			v := model.String
			h.Session.Model = &v
		}
		if parentID.Valid && parentID.String != "" {
			v := parentID.String
			h.Session.ParentSessionID = &v
		}
		h.Session.Profile = profile
		if t, ok := parseTime(startedAt); ok {
			h.Session.StartedAt = t
		}
		if t, ok := parseTime(lastAct); ok {
			h.Session.LastActivityAt = t
		}
		if usageSession.Valid {
			h.Session.Usage = &session.TokenUsage{
				TotalTokens:         totalTokens.Int64,
				InputTokens:         inputTokens.Int64,
				OutputTokens:        outputTokens.Int64,
				CachedTokens:        cachedTokens.Int64,
				CacheReadTokens:     cacheRead.Int64,
				CacheCreationTokens: cacheCreate.Int64,
			}
		}
		out = append(out, h)
		if len(out) >= limit {
			break
		}
	}
	return out, rows.Err()
}

type fts5QueryToken struct {
	text   string
	quote  bool
	syntax bool
}

func fts5SearchQuery(query string) string {
	tokens := tokenizeFTS5Query(query)
	parts := make([]string, 0, len(tokens))
	for i, tok := range tokens {
		part := normalizeFTS5Token(tok, operatorContext(tokens, i))
		if part != "" {
			parts = append(parts, part)
		}
	}
	return strings.Join(parts, " ")
}

func tokenizeFTS5Query(query string) []fts5QueryToken {
	var tokens []fts5QueryToken
	runes := []rune(query)
	pendingNear := false
	parenDepth := 0
	nearDepth := 0
	for i := 0; i < len(runes); {
		switch {
		case isSpace(runes[i]):
			i++
		case runes[i] == '"':
			var b strings.Builder
			i++
			for i < len(runes) {
				if runes[i] == '"' {
					if i+1 < len(runes) && runes[i+1] == '"' {
						b.WriteRune('"')
						i += 2
						continue
					}
					i++
					break
				}
				b.WriteRune(runes[i])
				i++
			}
			tokens = append(tokens, fts5QueryToken{text: b.String(), quote: true})
			pendingNear = false
		case isFTS5SyntaxRune(runes[i], pendingNear, nearDepth):
			tokens = append(tokens, fts5QueryToken{text: string(runes[i]), syntax: true})
			switch runes[i] {
			case '(':
				parenDepth++
				if pendingNear {
					nearDepth = parenDepth
				}
				pendingNear = false
			case ')':
				if parenDepth == nearDepth {
					nearDepth = 0
				}
				if parenDepth > 0 {
					parenDepth--
				}
				pendingNear = false
			}
			i++
		default:
			start := i
			for i < len(runes) && !isSpace(runes[i]) && runes[i] != '"' && !isFTS5SyntaxRune(runes[i], pendingNear, nearDepth) {
				i++
			}
			text := string(runes[start:i])
			tokens = append(tokens, fts5QueryToken{text: text})
			pendingNear = text == "NEAR"
		}
	}
	return tokens
}

func normalizeFTS5Token(tok fts5QueryToken, operatorOK bool) string {
	if tok.syntax {
		return tok.text
	}
	if tok.text == "" {
		return ""
	}
	if !tok.quote {
		switch tok.text {
		case "AND", "OR", "NOT", "NEAR":
			if operatorOK {
				return tok.text
			}
		}
		if isDigits(tok.text) {
			return tok.text
		}
	}
	prefix := !tok.quote && strings.HasSuffix(tok.text, "*") && len(tok.text) > 1
	text := tok.text
	if prefix {
		text = strings.TrimSuffix(text, "*")
	}
	if text == "" {
		return ""
	}
	quoted := `"` + strings.ReplaceAll(text, `"`, `""`) + `"`
	if prefix {
		return quoted + "*"
	}
	return quoted
}

func operatorContext(tokens []fts5QueryToken, i int) bool {
	tok := tokens[i]
	if tok.quote || tok.syntax {
		return false
	}
	switch tok.text {
	case "AND", "OR", "NOT":
		return i > 0 && i+1 < len(tokens) && isFTS5Operand(tokens[i-1]) && isFTS5Operand(tokens[i+1])
	case "NEAR":
		return i+1 < len(tokens) && tokens[i+1].syntax && tokens[i+1].text == "("
	default:
		return false
	}
}

func isFTS5Operand(tok fts5QueryToken) bool {
	if tok.syntax {
		return tok.text == ")"
	}
	return tok.text != ""
}

func isFTS5SyntaxRune(r rune, pendingNear bool, nearDepth int) bool {
	switch r {
	case '(':
		return pendingNear || nearDepth > 0
	case ')':
		return nearDepth > 0
	case ',':
		return nearDepth > 0
	default:
		return false
	}
}

func isSpace(r rune) bool {
	return unicode.IsSpace(r)
}

func isDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return s != ""
}

func isFTS5QueryError(err error) bool {
	return strings.Contains(err.Error(), "fts5:")
}
