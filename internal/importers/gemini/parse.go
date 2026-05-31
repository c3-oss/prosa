package gemini

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/c3-oss/prosa/internal/sessiontext"
	"github.com/c3-oss/prosa/pkg/session"
)

const firstPromptMaxRunes = 200

// envelope is the legacy session-*.json shape.
type envelope struct {
	SessionID   string    `json:"sessionId"`
	ProjectHash string    `json:"projectHash"`
	StartTime   string    `json:"startTime"`
	LastUpdated string    `json:"lastUpdated"`
	Messages    []message `json:"messages"`
}

// message covers fields from both shapes; absent fields stay zero.
type message struct {
	ID        string          `json:"id"`
	MessageID int             `json:"messageId"` // live shape
	SessionID string          `json:"sessionId"` // live shape
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Content   json.RawMessage `json:"content"` // legacy: string or array
	Message   string          `json:"message"` // live: plain string body
	Model     string          `json:"model"`
	Tokens    *geminiTokens   `json:"tokens"`
	ToolCalls []toolCall      `json:"toolCalls"`
}

type toolCall struct {
	Name string `json:"name"`
}

type geminiTokens struct {
	Cached  int64 `json:"cached"`
	Input   int64 `json:"input"`
	Output  int64 `json:"output"`
	Thought int64 `json:"thoughts"`
	Tool    int64 `json:"tool"`
	Total   int64 `json:"total"`
}

func hashAndSize(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = f.Close() }()

	h := sha256.New()
	size, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), size, nil
}

// peekSessionID inspects the top-level JSON to find a sessionId without
// fully parsing the messages.
func peekSessionID(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if id, _, ok := readEnvelopeID(data); ok {
		return id, nil
	}
	if id, ok := readArrayFirstSessionID(data); ok {
		return id, nil
	}
	return strings.TrimSuffix(filepath.Base(path), ".json"), nil
}

// parseSession decides between the two shapes and projects them.
func parseSession(ctx context.Context, path string) (session.Session, []session.Turn, []session.ToolUsage, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return session.Session{}, nil, nil, err
	}

	// Try envelope first.
	if id, env, ok := readEnvelopeID(data); ok {
		_ = id // session.ID set from env.SessionID below
		return projectEnvelope(ctx, env)
	}

	// Otherwise treat as live array.
	var rows []message
	if err := json.Unmarshal(data, &rows); err != nil {
		return session.Session{}, nil, nil, fmt.Errorf("decode gemini json: %w", err)
	}
	return projectLiveArray(ctx, rows)
}

func readEnvelopeID(data []byte) (string, envelope, bool) {
	if len(data) == 0 || data[0] != '{' {
		return "", envelope{}, false
	}
	var env envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return "", envelope{}, false
	}
	if env.SessionID == "" {
		return "", envelope{}, false
	}
	return env.SessionID, env, true
}

func readArrayFirstSessionID(data []byte) (string, bool) {
	if len(data) == 0 || data[0] != '[' {
		return "", false
	}
	var rows []message
	if err := json.Unmarshal(data, &rows); err != nil {
		return "", false
	}
	for _, r := range rows {
		if r.SessionID != "" {
			return r.SessionID, true
		}
	}
	return "", false
}

func projectEnvelope(ctx context.Context, env envelope) (session.Session, []session.Turn, []session.ToolUsage, error) {
	var sess session.Session
	sess.ID = env.SessionID
	if t, ok := parseTimestamp(env.StartTime); ok {
		sess.StartedAt = t
	}
	if t, ok := parseTimestamp(env.LastUpdated); ok {
		sess.LastActivityAt = t
	}

	var (
		turns          []session.Turn
		toolCounts     = map[string]int{}
		usage          session.TokenUsage
		usageSeen      = map[string]struct{}{}
		usageSet       bool
		firstPromptSet bool
	)
	for i, m := range env.Messages {
		if err := ctx.Err(); err != nil {
			return session.Session{}, nil, nil, err
		}
		if m.Type == "gemini" && collectGeminiUsage(m, i, usageSeen, &usage) {
			usageSet = true
		}
		ts, _ := parseTimestamp(m.Timestamp)
		if sess.StartedAt.IsZero() && !ts.IsZero() {
			sess.StartedAt = ts
		}
		if ts.After(sess.LastActivityAt) {
			sess.LastActivityAt = ts
		}

		text := extractText(m.Content)
		for _, tc := range m.ToolCalls {
			if tc.Name != "" {
				toolCounts[tc.Name]++
			}
		}

		role := mapType(m.Type)
		if role == "" || text == "" {
			if sess.Model == nil && m.Type == "gemini" && m.Model != "" {
				mm := m.Model
				sess.Model = &mm
			}
			continue
		}
		if role == "user" && !firstPromptSet {
			if prompt, ok := sessiontext.BuildFirstPrompt(text, firstPromptMaxRunes); ok {
				sess.FirstPrompt = &prompt
				firstPromptSet = true
			}
		}
		if sess.Model == nil && role == "assistant" && m.Model != "" {
			mm := m.Model
			sess.Model = &mm
		}
		turns = append(turns, session.Turn{Role: role, Content: text, Timestamp: ts})
	}

	tools := make([]session.ToolUsage, 0, len(toolCounts))
	for name, count := range toolCounts {
		tools = append(tools, session.ToolUsage{Name: name, Count: count})
	}
	if usageSet {
		sess.Usage = &usage
	}
	return sess, turns, tools, nil
}

// projectLiveArray groups records by sessionId and projects the largest
// group (most messages). The legacy bundle never hits this path; live
// logs.json may contain multiple sessions interleaved.
func projectLiveArray(ctx context.Context, rows []message) (session.Session, []session.Turn, []session.ToolUsage, error) {
	if len(rows) == 0 {
		return session.Session{}, nil, nil, fmt.Errorf("empty gemini logs.json array")
	}
	groups := map[string][]message{}
	for _, r := range rows {
		groups[r.SessionID] = append(groups[r.SessionID], r)
	}
	var (
		bestID    string
		bestCount int
	)
	for id, list := range groups {
		if len(list) > bestCount {
			bestID = id
			bestCount = len(list)
		}
	}
	if bestID == "" {
		return session.Session{}, nil, nil, fmt.Errorf("no sessionId found in logs.json")
	}

	var (
		sess           session.Session
		turns          []session.Turn
		usage          session.TokenUsage
		usageSeen      = map[string]struct{}{}
		usageSet       bool
		firstPromptSet bool
	)
	sess.ID = bestID
	for i, m := range groups[bestID] {
		if err := ctx.Err(); err != nil {
			return session.Session{}, nil, nil, err
		}
		if m.Type == "gemini" && collectGeminiUsage(m, i, usageSeen, &usage) {
			usageSet = true
		}
		ts, _ := parseTimestamp(m.Timestamp)
		if sess.StartedAt.IsZero() || ts.Before(sess.StartedAt) {
			if !ts.IsZero() {
				sess.StartedAt = ts
			}
		}
		if ts.After(sess.LastActivityAt) {
			sess.LastActivityAt = ts
		}

		role := mapType(m.Type)
		if role == "" {
			continue
		}
		text := m.Message
		if text == "" {
			text = extractText(m.Content)
		}
		if text == "" {
			continue
		}
		if role == "user" && !firstPromptSet {
			if prompt, ok := sessiontext.BuildFirstPrompt(text, firstPromptMaxRunes); ok {
				sess.FirstPrompt = &prompt
				firstPromptSet = true
			}
		}
		if sess.Model == nil && role == "assistant" && m.Model != "" {
			mm := m.Model
			sess.Model = &mm
		}
		turns = append(turns, session.Turn{Role: role, Content: text, Timestamp: ts})
	}
	if usageSet {
		sess.Usage = &usage
	}
	return sess, turns, nil, nil
}

func collectGeminiUsage(m message, idx int, seen map[string]struct{}, out *session.TokenUsage) bool {
	if m.Tokens == nil {
		return false
	}
	key := m.ID
	if key == "" && m.MessageID != 0 {
		key = fmt.Sprintf("message:%d", m.MessageID)
	}
	if key == "" {
		key = fmt.Sprintf("index:%d", idx)
	}
	if _, ok := seen[key]; ok {
		return false
	}
	seen[key] = struct{}{}
	total := m.Tokens.Total
	if total == 0 {
		total = m.Tokens.Input + m.Tokens.Output + m.Tokens.Thought + m.Tokens.Tool
	}
	out.TotalTokens += total
	out.InputTokens += m.Tokens.Input
	out.OutputTokens += m.Tokens.Output
	out.CachedTokens += m.Tokens.Cached
	out.CacheReadTokens += m.Tokens.Cached
	return true
}

func mapType(t string) string {
	switch t {
	case "user":
		return "user"
	case "gemini":
		return "assistant"
	}
	return ""
}

// extractText handles both string and array shapes of `content`. The
// array variant may carry typed items; the importer keeps every
// non-empty `text` field and joins with newlines.
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

func parseTimestamp(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UTC(), true
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC(), true
	}
	return time.Time{}, false
}
