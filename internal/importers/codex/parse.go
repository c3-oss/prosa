package codex

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/c3-oss/prosa/pkg/session"
)

const (
	// scanBufferMax matches claudecode — `event_msg.exec_command_end.stdout`
	// can carry multi-megabyte command output, same buffer pressure as
	// Claude's tool_result blocks.
	scanBufferMax = 16 << 20

	scanBufferInitial   = 64 << 10
	firstPromptMaxRunes = 200
)

// uuidSuffixRE pulls the session UUID out of a Codex filename suffix
// when session_meta is missing (older files / corrupt headers).
var uuidSuffixRE = regexp.MustCompile(
	`([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`,
)

// rawRecord carries fields from both record shapes Codex emits:
//   - Envelope: {type, timestamp, payload}.
//   - Legacy:   {type, role/content/name/...} at top level (no payload).
//
// json.Unmarshal silently leaves the absent fields zero-valued, which is
// exactly how we want to discriminate without a second pass.
type rawRecord struct {
	Type      string          `json:"type"`
	Timestamp string          `json:"timestamp"`
	Payload   json.RawMessage `json:"payload,omitempty"`

	// Legacy top-level fields used when Payload is empty.
	Role    string          `json:"role,omitempty"`
	Content json.RawMessage `json:"content,omitempty"`
	Name    string          `json:"name,omitempty"`
}

type sessionMetaPayload struct {
	ID  string `json:"id"`
	CWD string `json:"cwd"`
}

type turnContextPayload struct {
	Model string `json:"model"`
	CWD   string `json:"cwd"`
}

type responseItemPayload struct {
	Type    string          `json:"type"`
	Role    string          `json:"role"`
	Name    string          `json:"name"`
	Content json.RawMessage `json:"content"`
}

type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type eventMsgPayload struct {
	Type string          `json:"type"`
	Info *tokenCountInfo `json:"info"`
}

type tokenCountInfo struct {
	TotalTokenUsage *tokenUsageJSON `json:"total_token_usage"`
	LastTokenUsage  *tokenUsageJSON `json:"last_token_usage"`
}

type tokenUsageJSON struct {
	InputTokens          int64 `json:"input_tokens"`
	OutputTokens         int64 `json:"output_tokens"`
	TotalTokens          int64 `json:"total_tokens"`
	CachedInputTokens    int64 `json:"cached_input_tokens"`
	CacheReadInputTokens int64 `json:"cache_read_input_tokens"`
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

// peekSessionID reads only as many lines as needed to find a session_meta
// envelope (the canonical id holder). If absent, falls back to parsing
// the UUID suffix off the filename per docs/sources/codex.md.
func peekSessionID(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, scanBufferInitial), scanBufferMax)
	for sc.Scan() {
		var r rawRecord
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			continue
		}
		if r.Type == "session_meta" && len(r.Payload) > 0 {
			var p sessionMetaPayload
			if err := json.Unmarshal(r.Payload, &p); err == nil && p.ID != "" {
				return p.ID, nil
			}
		}
	}
	if err := sc.Err(); err != nil && !errors.Is(err, bufio.ErrTooLong) {
		return "", err
	}

	base := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	if m := uuidSuffixRE.FindStringSubmatch(base); m != nil {
		return m[1], nil
	}
	return base, nil
}

// parseSession streams the JSONL once and returns the projected metadata.
// Hash + size are computed separately by Import().
func parseSession(ctx context.Context, path string) (session.Session, []session.Turn, []session.ToolUsage, error) {
	f, err := os.Open(path)
	if err != nil {
		return session.Session{}, nil, nil, err
	}
	defer func() { _ = f.Close() }()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, scanBufferInitial), scanBufferMax)

	var (
		sess           session.Session
		turns          []session.Turn
		toolCounts     = map[string]int{}
		bestUsage      *session.TokenUsage
		sessIDSet      bool
		cwdSet         bool
		modelSet       bool
		firstPromptSet bool
		line           int
	)

	for sc.Scan() {
		line++
		if err := ctx.Err(); err != nil {
			return session.Session{}, nil, nil, err
		}

		var r rawRecord
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			slog.Warn("codex: malformed JSONL line skipped",
				"path", path, "line", line, "err", err)
			continue
		}

		if r.Timestamp != "" {
			if t, ok := parseTimestamp(r.Timestamp); ok {
				if sess.StartedAt.IsZero() || t.Before(sess.StartedAt) {
					sess.StartedAt = t
				}
				if t.After(sess.LastActivityAt) {
					sess.LastActivityAt = t
				}
			}
		}

		switch {
		case r.Type == "session_meta" && len(r.Payload) > 0:
			var p sessionMetaPayload
			if err := json.Unmarshal(r.Payload, &p); err != nil {
				continue
			}
			if !sessIDSet && p.ID != "" {
				sess.ID = p.ID
				sessIDSet = true
			}
			if !cwdSet && p.CWD != "" {
				cwd := p.CWD
				sess.ProjectPath = &cwd
				cwdSet = true
			}

		case r.Type == "turn_context" && len(r.Payload) > 0:
			var p turnContextPayload
			if err := json.Unmarshal(r.Payload, &p); err != nil {
				continue
			}
			if !modelSet && p.Model != "" {
				m := p.Model
				sess.Model = &m
				modelSet = true
			}
			if !cwdSet && p.CWD != "" {
				cwd := p.CWD
				sess.ProjectPath = &cwd
				cwdSet = true
			}

		case r.Type == "response_item" && len(r.Payload) > 0:
			var p responseItemPayload
			if err := json.Unmarshal(r.Payload, &p); err != nil {
				continue
			}
			handleResponseItem(p, r.Timestamp, &sess, &turns, &firstPromptSet, toolCounts)

		case r.Type == "event_msg" && len(r.Payload) > 0:
			if usage, ok := tokenUsageFromEvent(r.Payload); ok {
				if bestUsage == nil || usage.TotalTokens >= bestUsage.TotalTokens {
					u := usage
					bestUsage = &u
				}
			}

		case r.Type == "message":
			// Legacy top-level message record.
			handleLegacyMessage(r.Role, r.Content, r.Timestamp, &sess, &turns, &firstPromptSet)

		case r.Type == "function_call":
			// Legacy top-level function call.
			if r.Name != "" {
				toolCounts[r.Name]++
			}
		}
	}

	if err := sc.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			slog.Warn("codex: JSONL line exceeded 16 MiB scan buffer; partial session",
				"path", path, "line", line+1)
		} else {
			return session.Session{}, nil, nil, fmt.Errorf("scan %s: %w", path, err)
		}
	}

	tools := make([]session.ToolUsage, 0, len(toolCounts))
	for name, count := range toolCounts {
		tools = append(tools, session.ToolUsage{Name: name, Count: count})
	}
	if bestUsage != nil {
		sess.Usage = bestUsage
	}
	return sess, turns, tools, nil
}

func tokenUsageFromEvent(raw json.RawMessage) (session.TokenUsage, bool) {
	var p eventMsgPayload
	if err := json.Unmarshal(raw, &p); err != nil || p.Type != "token_count" || p.Info == nil {
		return session.TokenUsage{}, false
	}
	src := p.Info.TotalTokenUsage
	if src == nil {
		src = p.Info.LastTokenUsage
	}
	if src == nil {
		return session.TokenUsage{}, false
	}
	cached := src.CachedInputTokens
	if cached == 0 {
		cached = src.CacheReadInputTokens
	}
	if cached > src.InputTokens {
		cached = src.InputTokens
	}
	total := src.TotalTokens
	if total == 0 {
		total = src.InputTokens + src.OutputTokens
	}
	if total == 0 && src.InputTokens == 0 && src.OutputTokens == 0 && cached == 0 {
		return session.TokenUsage{}, false
	}
	return session.TokenUsage{
		TotalTokens:     total,
		InputTokens:     src.InputTokens,
		OutputTokens:    src.OutputTokens,
		CachedTokens:    cached,
		CacheReadTokens: cached,
	}, true
}

func handleResponseItem(
	p responseItemPayload,
	timestamp string,
	sess *session.Session,
	turns *[]session.Turn,
	firstPromptSet *bool,
	toolCounts map[string]int,
) {
	switch p.Type {
	case "message":
		text := extractMessageText(p.Content, p.Role)
		if text == "" {
			return
		}
		// `developer` role is intentionally dropped in cut 2 (analogous
		// to Claude Code's system/operational events).
		switch p.Role {
		case "user":
			if !*firstPromptSet {
				prompt := truncRunes(strings.Join(strings.Fields(text), " "), firstPromptMaxRunes)
				sess.FirstPrompt = &prompt
				*firstPromptSet = true
			}
			ts, _ := parseTimestamp(timestamp)
			*turns = append(*turns, session.Turn{Role: "user", Content: text, Timestamp: ts})
		case "assistant":
			ts, _ := parseTimestamp(timestamp)
			*turns = append(*turns, session.Turn{Role: "assistant", Content: text, Timestamp: ts})
		}

	case "function_call":
		if p.Name != "" {
			toolCounts[p.Name]++
		}
	}
}

func handleLegacyMessage(
	role string,
	content json.RawMessage,
	timestamp string,
	sess *session.Session,
	turns *[]session.Turn,
	firstPromptSet *bool,
) {
	text := extractMessageText(content, role)
	if text == "" {
		return
	}
	switch role {
	case "user":
		if !*firstPromptSet {
			prompt := truncRunes(strings.Join(strings.Fields(text), " "), firstPromptMaxRunes)
			sess.FirstPrompt = &prompt
			*firstPromptSet = true
		}
		ts, _ := parseTimestamp(timestamp)
		*turns = append(*turns, session.Turn{Role: "user", Content: text, Timestamp: ts})
	case "assistant":
		ts, _ := parseTimestamp(timestamp)
		*turns = append(*turns, session.Turn{Role: "assistant", Content: text, Timestamp: ts})
	}
}

// extractMessageText returns the joined text for a message's content,
// filtered by the role-appropriate block type. Codex uses:
//   - user      -> content[].type == "input_text"
//   - assistant -> content[].type == "output_text"
//
// Legacy records may carry `content` as a plain string instead of an
// array; that path is handled too.
func extractMessageText(content json.RawMessage, role string) string {
	if len(content) == 0 {
		return ""
	}
	var asString string
	if err := json.Unmarshal(content, &asString); err == nil {
		return asString
	}
	var blocks []contentBlock
	if err := json.Unmarshal(content, &blocks); err != nil {
		return ""
	}
	want := ""
	switch role {
	case "user":
		want = "input_text"
	case "assistant":
		want = "output_text"
	default:
		return ""
	}
	var parts []string
	for _, b := range blocks {
		// Some legacy blocks have only a `text` field with no `type`.
		// We accept those when role matches; the safe assumption is the
		// block belongs to the speaker.
		if (b.Type == want || b.Type == "") && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func parseTimestamp(s string) (time.Time, bool) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UTC(), true
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC(), true
	}
	return time.Time{}, false
}

func truncRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max-1]) + "…"
}
