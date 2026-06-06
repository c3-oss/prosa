package hermes

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/c3-oss/prosa/internal/importers/importerutil"
	"github.com/c3-oss/prosa/internal/sessiontext"
	"github.com/c3-oss/prosa/pkg/session"
)

// hermesMessage is the loose shape carried by JSONL lines, snapshot
// `messages[]` entries, and state.db `messages` rows. Fields absent in a
// given shape stay zero-valued.
type hermesMessage struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	Timestamp  json.RawMessage `json:"timestamp"` // float seconds or ISO string
	Model      string          `json:"model"`
	SessionID  string          `json:"session_id"`
	ToolCalls  json.RawMessage `json:"tool_calls"`
	TokenCount *int64          `json:"token_count"`
}

// snapshotEnvelope is the session_<id>.json shape.
type snapshotEnvelope struct {
	SessionID    string          `json:"session_id"`
	SessionStart string          `json:"session_start"`
	LastUpdated  string          `json:"last_updated"`
	Platform     string          `json:"platform"`
	Model        string          `json:"model"`
	SystemPrompt string          `json:"system_prompt"`
	Messages     []hermesMessage `json:"messages"`
}

// stateDBRow is one row from state.db's `sessions` table — only the
// columns the projection needs are scanned.
type stateDBRow struct {
	id           string
	model        sql.NullString
	startedAt    sql.NullFloat64
	startedAtStr sql.NullString
	messageCount sql.NullInt64
}

// toolCall is one entry of a Hermes `tool_calls` array.
type toolCall struct {
	Name string `json:"name"`
}

// peekSnapshotID returns the session id from a snapshot file: the
// envelope's session_id when present, otherwise the filename stem with
// the leading `session_` stripped.
func peekSnapshotID(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var env snapshotEnvelope
	if err := json.Unmarshal(data, &env); err == nil && env.SessionID != "" {
		return env.SessionID, nil
	}
	base := strings.TrimSuffix(filepath.Base(path), ".json")
	return strings.TrimPrefix(base, "session_"), nil
}

// parseJSONL streams one JSON object per line and projects the canonical
// session. Timestamps may be epoch-seconds floats or ISO strings; both
// are tried.
func parseJSONL(ctx context.Context, path string) (session.Session, []session.Turn, []session.ToolUsage, session.UsageState, error) {
	f, err := os.Open(path)
	if err != nil {
		return session.Session{}, nil, nil, session.UsageStateUnknown, err
	}
	defer func() { _ = f.Close() }()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, importerutil.ScanBufferInitial), importerutil.ScanBufferMax)

	var msgs []hermesMessage
	for sc.Scan() {
		if err := ctx.Err(); err != nil {
			return session.Session{}, nil, nil, session.UsageStateUnknown, err
		}
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var m hermesMessage
		if err := json.Unmarshal(line, &m); err != nil {
			continue
		}
		msgs = append(msgs, m)
	}
	if err := sc.Err(); err != nil {
		return session.Session{}, nil, nil, session.UsageStateUnknown, fmt.Errorf("scan jsonl: %w", err)
	}
	sess, turns, tools, state := projectMessagesWithDefaults(msgs, time.Time{}, time.Time{}, "")
	return sess, turns, tools, state, nil
}

// parseSnapshot reads a session_<id>.json envelope and projects it.
func parseSnapshot(ctx context.Context, path string) (session.Session, []session.Turn, []session.ToolUsage, session.UsageState, error) {
	if err := ctx.Err(); err != nil {
		return session.Session{}, nil, nil, session.UsageStateUnknown, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return session.Session{}, nil, nil, session.UsageStateUnknown, err
	}
	var env snapshotEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return session.Session{}, nil, nil, session.UsageStateUnknown, fmt.Errorf("decode snapshot json: %w", err)
	}

	envStart, _ := importerutil.ParseRFC3339(env.SessionStart)
	envEnd, _ := importerutil.ParseRFC3339(env.LastUpdated)
	sess, turns, tools, state := projectMessagesWithDefaults(env.Messages, envStart, envEnd, env.Model)
	if sess.ID == "" {
		sess.ID = env.SessionID
	}
	return sess, turns, tools, state, nil
}

// projectMessagesWithDefaults projects a slice of hermesMessage into the
// canonical session/turns/tools triple plus a UsageState classifier.
// envStart / envEnd / envModel supply envelope-level fallbacks for the
// snapshot and state.db paths; the JSONL path passes zero values and
// relies on per-message fields.
func projectMessagesWithDefaults(msgs []hermesMessage, envStart, envEnd time.Time, envModel string) (session.Session, []session.Turn, []session.ToolUsage, session.UsageState) {
	var (
		sess           session.Session
		turns          []session.Turn
		toolCounts     = map[string]int{}
		tokenTotal     int64
		tokenSet       bool
		firstPromptSet bool
	)
	if !envStart.IsZero() {
		sess.StartedAt = envStart
	}
	if !envEnd.IsZero() {
		sess.LastActivityAt = envEnd
	}

	for _, m := range msgs {
		if m.TokenCount != nil {
			tokenTotal += *m.TokenCount
			tokenSet = true
		}
		ts := messageTime(m.Timestamp)
		if !ts.IsZero() {
			if sess.StartedAt.IsZero() || ts.Before(sess.StartedAt) {
				sess.StartedAt = ts
			}
			if ts.After(sess.LastActivityAt) {
				sess.LastActivityAt = ts
			}
		}

		for _, name := range extractToolCallNames(m.ToolCalls) {
			toolCounts[name]++
		}

		// Pick up the first assistant-side model name we see.
		if sess.Model == nil && m.Role == "assistant" && m.Model != "" {
			mm := m.Model
			sess.Model = &mm
		}

		text := extractText(m.Content)
		if text == "" {
			continue
		}
		switch m.Role {
		case "user":
			if !firstPromptSet {
				if prompt, ok := sessiontext.BuildFirstPrompt(text, importerutil.FirstPromptMaxRunes); ok {
					sess.FirstPrompt = &prompt
					firstPromptSet = true
				}
			}
			turns = append(turns, session.Turn{Role: "user", Content: text, Timestamp: ts})
		case "assistant":
			turns = append(turns, session.Turn{Role: "assistant", Content: text, Timestamp: ts})
		}
	}

	if sess.Model == nil && envModel != "" {
		mm := envModel
		sess.Model = &mm
	}

	tools := make([]session.ToolUsage, 0, len(toolCounts))
	for name, count := range toolCounts {
		tools = append(tools, session.ToolUsage{Name: name, Count: count})
	}
	if tokenSet {
		sess.Usage = &session.TokenUsage{TotalTokens: tokenTotal}
	}
	state := session.ClassifyUsage(tokenSet, sess.Usage)
	return sess, turns, tools, state
}

// extractText handles the two content shapes Hermes emits: a plain
// string body, or an array of typed items where `text` items carry the
// projection text.
func extractText(content json.RawMessage) string {
	if len(content) == 0 {
		return ""
	}
	var asString string
	if err := json.Unmarshal(content, &asString); err == nil {
		return asString
	}
	var items []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(content, &items); err != nil {
		return ""
	}
	var parts []string
	for _, it := range items {
		if it.Text != "" {
			parts = append(parts, it.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// extractToolCallNames decodes the `tool_calls` array and returns the
// `name` field of every entry that carries one.
func extractToolCallNames(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var calls []toolCall
	if err := json.Unmarshal(raw, &calls); err != nil {
		return nil
	}
	out := make([]string, 0, len(calls))
	for _, c := range calls {
		if c.Name != "" {
			out = append(out, c.Name)
		}
	}
	return out
}

// messageTime parses a Hermes message timestamp. Hermes writes epoch
// seconds as a JSON number, but older transcripts shipped ISO 8601
// strings; both shapes are accepted.
func messageTime(raw json.RawMessage) time.Time {
	if len(raw) == 0 {
		return time.Time{}
	}
	var asFloat float64
	if err := json.Unmarshal(raw, &asFloat); err == nil {
		return floatToTime(asFloat)
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		t, _ := importerutil.ParseRFC3339(asString)
		return t
	}
	return time.Time{}
}

func floatToTime(t float64) time.Time {
	sec := int64(t)
	nsec := int64((t - float64(sec)) * 1e9)
	return time.Unix(sec, nsec).UTC()
}

// readStateDBSessions returns one row per Hermes session, ordered by
// started_at ascending. Timestamp columns can be REAL or TEXT in the
// wild so both are queried.
func readStateDBSessions(ctx context.Context, path string) ([]stateDBRow, error) {
	db, err := importerutil.OpenSQLiteReadOnly(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()

	rows, err := db.QueryContext(ctx, `SELECT id, model, started_at, message_count FROM sessions ORDER BY started_at`)
	if err != nil {
		return nil, fmt.Errorf("query sessions: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []stateDBRow
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var (
			id           string
			model        sql.NullString
			startedAt    any
			messageCount sql.NullInt64
		)
		if err := rows.Scan(&id, &model, &startedAt, &messageCount); err != nil {
			return nil, fmt.Errorf("scan session: %w", err)
		}
		row := stateDBRow{id: id, model: model, messageCount: messageCount}
		switch v := startedAt.(type) {
		case float64:
			row.startedAt = sql.NullFloat64{Float64: v, Valid: true}
		case int64:
			row.startedAt = sql.NullFloat64{Float64: float64(v), Valid: true}
		case string:
			row.startedAtStr = sql.NullString{String: v, Valid: true}
		case []byte:
			row.startedAtStr = sql.NullString{String: string(v), Valid: true}
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate sessions: %w", err)
	}
	return out, nil
}

// projectStateDBSession reads every message row for the given session id
// and projects it through the shared message projection. Envelope-level
// defaults come from the session row's started_at and model columns.
func projectStateDBSession(ctx context.Context, path string, row stateDBRow) (session.Session, []session.Turn, []session.ToolUsage, session.UsageState, error) {
	db, err := importerutil.OpenSQLiteReadOnly(path)
	if err != nil {
		return session.Session{}, nil, nil, session.UsageStateUnknown, err
	}
	defer func() { _ = db.Close() }()

	hasTokenCount, err := tableHasColumn(ctx, db, "messages", "token_count")
	if err != nil {
		return session.Session{}, nil, nil, session.UsageStateUnknown, err
	}
	query := `SELECT role, content, tool_calls, timestamp FROM messages WHERE session_id = ? ORDER BY id`
	if hasTokenCount {
		query = `SELECT role, content, tool_calls, timestamp, token_count FROM messages WHERE session_id = ? ORDER BY id`
	}
	rows, err := db.QueryContext(ctx, query, row.id)
	if err != nil {
		return session.Session{}, nil, nil, session.UsageStateUnknown, fmt.Errorf("query messages: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var msgs []hermesMessage
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return session.Session{}, nil, nil, session.UsageStateUnknown, err
		}
		var (
			role      sql.NullString
			content   sql.NullString
			toolCalls sql.NullString
			token     sql.NullInt64
			ts        any
		)
		if hasTokenCount {
			err = rows.Scan(&role, &content, &toolCalls, &ts, &token)
		} else {
			err = rows.Scan(&role, &content, &toolCalls, &ts)
		}
		if err != nil {
			return session.Session{}, nil, nil, session.UsageStateUnknown, fmt.Errorf("scan message: %w", err)
		}
		m := hermesMessage{Role: role.String}
		if token.Valid {
			v := token.Int64
			m.TokenCount = &v
		}
		if content.Valid {
			m.Content = json.RawMessage(rawStringToJSON(content.String))
		}
		if toolCalls.Valid && toolCalls.String != "" {
			m.ToolCalls = json.RawMessage(toolCalls.String)
		}
		switch v := ts.(type) {
		case float64:
			m.Timestamp = json.RawMessage(fmt.Sprintf("%g", v))
		case int64:
			m.Timestamp = json.RawMessage(fmt.Sprintf("%d", v))
		case string:
			if b, err := json.Marshal(v); err == nil {
				m.Timestamp = b
			}
		case []byte:
			if b, err := json.Marshal(string(v)); err == nil {
				m.Timestamp = b
			}
		}
		msgs = append(msgs, m)
	}
	if err := rows.Err(); err != nil {
		return session.Session{}, nil, nil, session.UsageStateUnknown, fmt.Errorf("iterate messages: %w", err)
	}

	var envStart time.Time
	if row.startedAt.Valid {
		envStart = floatToTime(row.startedAt.Float64)
	} else if row.startedAtStr.Valid {
		envStart, _ = importerutil.ParseRFC3339(row.startedAtStr.String)
	}
	envModel := ""
	if row.model.Valid {
		envModel = row.model.String
	}

	sess, turns, tools, state := projectMessagesWithDefaults(msgs, envStart, time.Time{}, envModel)
	sess.ID = row.id
	return sess, turns, tools, state, nil
}

func tableHasColumn(ctx context.Context, db *sql.DB, table, column string) (bool, error) {
	rows, err := db.QueryContext(ctx, "PRAGMA table_info("+table+")")
	if err != nil {
		return false, fmt.Errorf("inspect %s schema: %w", table, err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var (
			cid     int
			name    string
			ctype   string
			notNull int
			dflt    any
			pk      int
		)
		if err := rows.Scan(&cid, &name, &ctype, &notNull, &dflt, &pk); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

// rawStringToJSON wraps an arbitrary content string as a JSON string so
// projectMessages' RawMessage parser sees a valid value. If the string
// already looks like a JSON array or object it's passed through verbatim
// so the array-of-typed-items branch keeps working.
func rawStringToJSON(s string) string {
	t := strings.TrimSpace(s)
	if t == "" {
		return `""`
	}
	if t[0] == '[' || t[0] == '{' {
		return s
	}
	b, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(b)
}

// siblingHasMore reports whether a sibling transcript exists with more
// messages than the state.db row claims. Used to defer to the dedicated
// .jsonl / .json Import call when present.
func siblingHasMore(sessionsDir, id string, claimed sql.NullInt64) bool {
	jsonlPath := filepath.Join(sessionsDir, id+".jsonl")
	if n, ok := countJSONLLines(jsonlPath); ok {
		if !claimed.Valid || int64(n) > claimed.Int64 {
			return true
		}
	}
	snapPath := filepath.Join(sessionsDir, "session_"+id+".json")
	if n, ok := countSnapshotMessages(snapPath); ok {
		if !claimed.Valid || int64(n) > claimed.Int64 {
			return true
		}
	}
	return false
}

func countJSONLLines(path string) (int, bool) {
	f, err := os.Open(path)
	if err != nil {
		return 0, false
	}
	defer func() { _ = f.Close() }()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, importerutil.ScanBufferInitial), importerutil.ScanBufferMax)
	n := 0
	for sc.Scan() {
		if len(strings.TrimSpace(sc.Text())) > 0 {
			n++
		}
	}
	if err := sc.Err(); err != nil {
		return 0, false
	}
	return n, true
}

func countSnapshotMessages(path string) (int, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	var env struct {
		Messages []json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return 0, false
	}
	return len(env.Messages), true
}
